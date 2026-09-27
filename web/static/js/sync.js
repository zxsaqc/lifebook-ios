// 端到端加密同步引擎。
//
// 设计目标：把「手机为主」的数据搬到任意一个「哑存储」上（iCloud Drive / WebDAV /
// 自建服务），而**云端只见密文**。服务商拿到的是一堆随机 ID + 时间戳 + 密文，
// 既不知道你在记什么，也不知道有几个账号、花了多少钱。
//
// 云端仓库结构（所有路径都相对于一个目录，例如 /dav/lifebook/）：
//
//   manifest.json          明文。账库身份 + 派生参数 + 校验密文（都不含秘密）
//   devices/<deviceId>.json 明文容器，内部行全是密文
//
// 为什么是「每台设备一份文件」而不是一台一份共享数据库：
// 每台设备只写自己的文件，**写冲突在结构上就不存在**，不需要锁、不需要 ETag 重试、
// 不需要处理「两边同时改同一条」的覆盖问题。代价是每份文件都保存了该设备已知的
// 全部记录（个人量级下几台设备、几千条记录，完全可接受）。
//
// 行格式（写进 devices/*.json 的 rows 数组）：
//
//   { i: 记录ID, u: 更新时间, b: 密文 }
//
// 密文解出来是 { k: 类别, u: 更新时间, r: 记录本体 }。
// 注意两点刻意的设计：
//   1. **类别不放在明文里**（不像很多人第一反应那样把 kind 写在外面）。类别会暴露
//      「记了多少条账 / 多少条影视」，算是行为元数据，能藏就藏。
//   2. 密文里带一份 u，读取时和明文的 u 比对。因为 AES-GCM 只保护密文本身，
//      云端如果恶意把 u 改小，就能让一条记录「被回滚」。比对一次就挡住了。
//
// 合并规则：同一条记录取 u 更大的那份（Last-Write-Wins）。u 完全相同时用密文串
// 做字典序兜底，保证任何设备算出来的结果**完全一致**，不会出现两台设备互相打架。
// 删除不做物理删除，而是保留一条 deleted_at 非空的记录（墓碑），否则删掉的记录
// 会被另一台设备重新同步回来。

export const REPO_FORMAT = "lifebook-vault";
export const LOG_FORMAT = "lifebook-device-log";
export const REPO_VERSION = 1;

export const MANIFEST_PATH = "manifest.json";
export const DEVICE_DIR = "devices";

/** 参与同步的数据类别。附件（照片）默认不同步，可显式打开。 */
export const SYNC_KINDS = ["account", "transaction", "session", "journal", "media", "rule"];

/* ---------------- 仓库元信息 ---------------- */

/** manifest.json 的内容：全是公开参数，没有一个是秘密。 */
export function makeManifest({ vaultId, salt, verifier, deviceName }) {
  const now = new Date().toISOString();
  return {
    format: REPO_FORMAT,
    version: REPO_VERSION,
    vault_id: vaultId,
    salt,
    verifier,
    kdf: { algo: "PBKDF2-SHA256", rounds: 250000 },
    cipher: "AES-256-GCM",
    created_by: deviceName || "",
    created_at: now,
    updated_at: now,
  };
}

export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ---------------- 行编码 / 解码 ---------------- */

/**
 * 把明文记录编成一行密文。
 * `record.deleted_at` 非空就是墓碑——仍然保留记录本体，这样另一台设备拿到后
 * 只是把它标记为已删除，而不是把数据丢掉。
 *
 * @param {(plain: string) => Promise<string>} enc 加密函数（用当前账库密钥）
 */
export async function encodeRow(enc, kind, record) {
  const u = record.updated_at || record.created_at || new Date().toISOString();
  const payload = JSON.stringify({
    k: kind,
    u,
    id: record.id,
    r: record,
  });
  return { i: record.id, u, b: await enc(payload) };
}

/**
 * 解出一行；密文被改过、时间戳对不上、密钥不对都会返回 null。
 *
 * @param {(cipher: string) => Promise<string>} dec 解密函数
 */
export async function decodeRow(dec, row) {
  let payload;
  try {
    payload = JSON.parse(await dec(row.b));
  } catch {
    return null;
  }
  if (!payload || payload.id !== row.i || payload.u !== row.u) return null;
  return payload;
}

/* ---------------- 合并 ---------------- */

/**
 * 行比较：**只看版本时间戳**。
 *
 * 这里刻意不去比较密文。原因是每次编码都会生成新的随机 IV，同一个记录的密文
 * 每次都不一样，拿它当「谁更新」的依据会得出错误结论（比如自己刚推上去的记录
 * 又被自己当成新的拉回来）。时间戳就是版本号，这是唯一的依据。
 */
export function compareRows(a, b) {
  if (a.u === b.u) return 0;
  return a.u < b.u ? -1 : 1;
}

/**
 * 合并多个来源。
 *
 * @param {Array<{deviceId: string, rows: Array}>} sources
 *
 * 先把来源按 deviceId 排序，再依次折叠；时间戳相同时**排在后面的设备赢**。
 * 这样无论在哪台设备上算、以什么顺序读到云端文件，结果都完全一致。
 */
export function mergeSources(sources) {
  const ordered = [...(sources || [])].sort((a, b) => {
    const x = String(a.deviceId || "");
    const y = String(b.deviceId || "");
    if (x === y) return 0;
    return x < y ? -1 : 1;
  });
  const best = new Map();
  for (const src of ordered) {
    for (const row of src.rows || []) {
      if (!row || !row.i) continue;
      const cur = best.get(row.i);
      if (!cur || compareRows(row, cur) >= 0) best.set(row.i, row);
    }
  }
  return best;
}

/** 本机记录 → 行密文（用于推送自己的那份日志）。 */
export async function encodeAll(enc, records, { includeAttachments = false } = {}) {
  const kinds = includeAttachments ? [...SYNC_KINDS, "attachment"] : SYNC_KINDS;
  const rows = [];
  for (const kind of kinds) {
    for (const record of records[kind] || []) {
      if (!record || !record.id) continue;
      rows.push(await encodeRow(enc, kind, record));
    }
  }
  return rows;
}

/* ---------------- 设备日志 ---------------- */

export function makeDeviceLog({ deviceId, deviceName, vaultId, rows, prev }) {
  return {
    format: LOG_FORMAT,
    version: REPO_VERSION,
    vault_id: vaultId,
    device_id: deviceId,
    device_name: deviceName,
    seq: ((prev && prev.seq) || 0) + 1,
    row_count: rows.length,
    updated_at: new Date().toISOString(),
    rows,
  };
}

/** 设备日志目录下的文件名。只允许安全字符，避免拼出奇怪的路径。 */
export function deviceLogPath(deviceId) {
  const safe = String(deviceId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new SyncError("bad_device_id", "设备标识不合法");
  return `${DEVICE_DIR}/${safe}.json`;
}

/* ---------------- 传输层 ----------------
 *
 * App 里必须走本机代理：WebDAV 服务器基本都不返回 CORS 头，网页里直接 fetch
 * 会被浏览器拦掉（原生那侧没有这个限制）。所以先探测 App 里的代理在不在，
 * 在就优先用它；不在（比如电脑浏览器直接打开）就退回直连。
 */

export function authHeader(username, password) {
  if (!username) return "";
  const raw = `${username}:${password || ""}`;
  // 账号密码可能含中文，先转 UTF-8 再 base64
  const bytes = new TextEncoder().encode(raw);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `Basic ${btoa(s)}`;
}

async function proxyTransport({ url, method, headers, body, auth }) {
  const res = await fetch("/__sync__", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Dav-Url": url,
      "X-Dav-Method": method,
      ...(auth ? { "X-Dav-Auth": auth } : {}),
      ...(headers || {}),
    },
    body: body === undefined ? null : body,
  });
  if (!res.ok) throw new SyncError("transport_error", `本机代理返回 ${res.status}`);
  return {
    status: Number(res.headers.get("X-Dav-Status") || 0),
    text: await res.text(),
    etag: res.headers.get("X-Dav-Etag") || "",
  };
}

async function directTransport({ url, method, headers, body, auth }) {
  const res = await fetch(url, {
    method,
    headers: { ...(headers || {}), ...(auth ? { Authorization: auth } : {}) },
    body: body === undefined ? null : body,
  });
  return { status: res.status, text: await res.text(), etag: res.headers.get("ETag") || "" };
}

let proxyProbe = null;

/** 一次性探测 App 内代理是否可用（同一个页面只探一次）。 */
export async function detectTransport() {
  if (proxyProbe) return proxyProbe;
  proxyProbe = (async () => {
    try {
      const res = await fetch("/__sync__/ping", { method: "GET" });
      if (res.ok && (await res.text()).trim() === "lifebook-sync-proxy") return proxyTransport;
    } catch {
      /* 没有代理是正常情况 */
    }
    return directTransport;
  })();
  return proxyProbe;
}

export function resetTransportProbe() {
  proxyProbe = null;
}

/* ---------------- 存储后端 ---------------- */

/** 后端接口：read / write / list / remove。测试里用 MemoryBackend，生产用 WebDAV。 */
export class MemoryBackend {
  constructor() {
    this.files = new Map();
    this.writes = 0;
  }
  async read(path) {
    return this.files.has(path) ? { text: this.files.get(path) } : null;
  }
  async write(path, text) {
    this.writes += 1;
    this.files.set(path, text);
    return { etag: `mem-${this.writes}` };
  }
  async list(prefix) {
    return [...this.files.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ path: k, size: this.files.get(k).length }));
  }
  async remove(path) {
    this.files.delete(path);
  }
}

/**
 * WebDAV 后端。适配坚果云 / Nextcloud / 群晖 / Alist 等任何标准 WebDAV。
 * 只用到 4 个方法：GET、PUT、DELETE、PROPFIND。
 */
export class WebDavBackend {
  constructor({ baseUrl, username = "", password = "", transport = null }) {
    if (!baseUrl) throw new SyncError("bad_config", "缺少服务器地址");
    this.baseUrl = String(baseUrl).trim().replace(/\/+$/, "");
    this.username = username;
    this.password = password;
    this.auth = authHeader(username, password);
    this.transport = transport;
    this.writes = 0;
  }

  url(path) {
    return `${this.baseUrl}/${String(path).split("/").map(encodeURIComponent).join("/")}`;
  }

  /** 统一的失败映射：认证问题要单独报，否则用户只能看到「HTTP 401」。 */
  _fail(status, what) {
    if (status === 401 || status === 403) {
      return new SyncError("invalid_credential", "服务器拒绝登录，请检查账号与应用密码");
    }
    if (status === 507) return new SyncError("backend_error", "云端空间不足");
    return new SyncError("backend_error", `${what}失败（HTTP ${status}）`);
  }

  async _send(method, path, { body, headers } = {}) {
    const transport = this.transport || (await detectTransport());
    return transport({
      url: this.url(path),
      method,
      headers,
      body,
      auth: this.auth,
    });
  }

  async read(path) {
    const res = await this._send("GET", path);
    if (res.status === 404) return null;
    if (res.status >= 400) throw this._fail(res.status, "读取");
    return { text: res.text, etag: res.etag };
  }

  async write(path, text) {
    const res = await this._send("PUT", path, {
      body: text,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    if (res.status >= 400) throw this._fail(res.status, "写入");
    this.writes += 1;
    return { etag: res.etag };
  }

  async remove(path) {
    const res = await this._send("DELETE", path);
    if (res.status >= 400 && res.status !== 404) throw this._fail(res.status, "删除");
  }

  /** 列目录（Depth: 1），返回相对 baseUrl 的路径。 */
  async list(prefix) {
    const dir = String(prefix).replace(/\/+$/, "");
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/>' +
      "<D:getcontentlength/><D:getetag/></D:prop></D:propfind>";

    let res = await this._send("PROPFIND", dir, {
      body,
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    });
    // 有些服务器对不带结尾斜杠的集合会返回 301/307。自动跟随一次，
    // 否则用户少打一个斜杠就会看到「列目录失败」。
    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
      res = await this._send("PROPFIND", `${dir}/`, {
        body,
        headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      });
    }
    if (res.status === 404) return [];
    if (res.status >= 400) throw this._fail(res.status, "列目录");

    const basePath = new URL(this.baseUrl).pathname.replace(/\/+$/, "");
    const dirKey = dir ? `${dir.replace(/\/+$/, "")}/` : "";
    const out = [];

    for (const m of res.text.matchAll(/<[^>]*href[^>]*>([^<]*)<\/[^>]*href>/gi)) {
      let href = m[1].trim();
      if (!href) continue;
      try {
        href = decodeURIComponent(href);
      } catch {
        /* 原样使用 */
      }
      if (/^https?:\/\//i.test(href)) href = new URL(href).pathname;

      // 1. 先归一化成「相对于 baseUrl 的路径」。不在这棵子树下的一律丢掉——
      //    前缀相同并不等于在下面（/dav/lifebook2 就不是 /dav/lifebook 的子目录），
      //    所以必须比到分隔符为止。
      const absolute = href.startsWith("/");
      let rel;
      if (absolute) {
        if (!basePath) {
          rel = href.replace(/^\/+/, "");
        } else if (href === basePath) {
          continue; // 集合自身
        } else if (href.startsWith(`${basePath}/`)) {
          rel = href.slice(basePath.length + 1);
        } else {
          continue; // 别人的路径，与本次同步无关
        }
      } else {
        rel = href.replace(/^\.\//, "");
      }

      if (!rel || rel.endsWith("/")) continue; // 子目录本身

      // 2. 再只保留目标目录下的条目
      if (dirKey) {
        if (rel.startsWith(dirKey)) {
          // 正常情况：服务器返回的是完整路径
        } else if (!absolute && !rel.includes("/")) {
          // 少数服务器返回的是相对当前集合的裸文件名。
          // 只对**相对** href 这样兜底——否则根目录的文件会被误挂到子目录下。
          rel = dirKey + rel;
        } else {
          continue;
        }
      } else if (rel.includes("/")) {
        // Depth:1 只该给出本级文件，子目录里的条目一律忽略
        continue;
      }
      out.push({ path: rel, size: 0 });
    }
    return out;
  }

  /** 连接测试：只看目录能不能访问，顺便验证账号密码。 */
  async probe() {
    const res = await this._send("PROPFIND", "", {
      headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    });
    if (res.status < 400) return true;
    throw this._fail(res.status, "访问该地址");
  }
}

/**
 * 判断云端账库和本机是什么关系，让界面知道下一步该做什么。
 * - 云端没有账库           → action: "publish"（首次上传）
 * - 云端就是本机这个账库   → action: "sync"（直接同步）
 * - 云端是另一个账库       → action: "adopt"（加入，需要重新输主口令）
 */
export function evaluateRepo(manifest, localVaultId) {
  if (!manifest) {
    return { has_repo: false, same_vault: false, action: "publish" };
  }
  const same = manifest.vault_id === localVaultId;
  return {
    has_repo: true,
    same_vault: same,
    vault_id: manifest.vault_id,
    created_at: manifest.created_at || "",
    kdf_rounds: (manifest.kdf && manifest.kdf.rounds) || 0,
    action: same ? "sync" : "adopt",
  };
}

/* ---------------- 同步引擎 ---------------- */
/**
 * 一次同步的完整流程：
 *   1. 读 manifest，确认云端账库身份
 *   2. 读所有设备的日志
 *   3. 合并（本机 ∪ 云端）
 *   4. 把云端更更新的记录落到本机
 *   5. 把合并结果写回自己那一份日志
 *
 * `local` 是本机数据层的适配器，见 synclocal.js：
 *   crypto: {encrypt, decrypt}   用账库密钥加解密
 *   records(): {kind: [记录]}     当前全部明文记录
 *   apply(rows): Promise<stats>   把云端行落到本机
 *   meta: {vaultId, salt, verifier, deviceId, deviceName}
 */
export class SyncEngine {
  constructor({ backend, local, includeAttachments = false, logger = null }) {
    this.backend = backend;
    this.local = local;
    this.includeAttachments = includeAttachments;
    this.log = logger || (() => {});
  }

  async readManifest() {
    const file = await this.backend.read(MANIFEST_PATH);
    if (!file) return null;
    let manifest;
    try {
      manifest = JSON.parse(file.text);
    } catch {
      throw new SyncError("bad_repo", "云端 manifest 无法解析，可能不是 LifeBook 的同步目录");
    }
    if (manifest.format !== REPO_FORMAT) {
      throw new SyncError("bad_repo", "该目录不是 LifeBook 同步目录");
    }
    return manifest;
  }

  /** 首次启用：把自己的账库身份发布到云端。 */
  async publish({ deviceName }) {
    const meta = this.local.meta;
    if (!meta.vaultId || !meta.salt || !meta.verifier) {
      throw new SyncError("bad_state", "本机账库身份不完整，请先重新解锁");
    }
    const existing = await this.readManifest();
    if (existing && existing.vault_id !== meta.vaultId) {
      throw new SyncError("vault_mismatch", "云端已存在另一个账库，请改用「加入已有账库」");
    }
    if (!existing) {
      await this.backend.write(
        MANIFEST_PATH,
        JSON.stringify(makeManifest({ ...meta, deviceName }), null, 2)
      );
    }
    return this.sync();
  }

  /** 拉取云端所有设备的行，按来源分开返回（合并时要用 deviceId 定序）。 */
  async pullRows() {
    const entries = await this.backend.list(DEVICE_DIR);
    const sources = [];
    for (const entry of entries) {
      if (!entry.path.endsWith(".json")) continue;
      const file = await this.backend.read(entry.path);
      if (!file) continue;
      let log;
      try {
        log = JSON.parse(file.text);
      } catch {
        this.log(`跳过无法解析的日志 ${entry.path}`);
        continue;
      }
      if (log.format !== LOG_FORMAT || !Array.isArray(log.rows)) continue;
      sources.push({ deviceId: log.device_id || entry.path, rows: log.rows });
    }
    return sources;
  }

  /**
   * 跑一轮同步。
   *
   * @param {object} opts
   * @param {boolean} opts.dryRun 只算不写，用于预览
   */
  async sync({ dryRun = false } = {}) {
    const meta = this.local.meta;
    const manifest = await this.readManifest();
    if (!manifest) throw new SyncError("no_repo", "云端还没有账库，请先「首次上传」");
    if (manifest.vault_id !== meta.vaultId) {
      throw new SyncError(
        "vault_mismatch",
        "本机账库与云端账库不是同一个，请先「加入已有账库」"
      );
    }

    const { encrypt, decrypt } = this.local.crypto;
    const records = this.local.records();

    // 1. 把自己的明文记录编成行
    const ownRows = await encodeAll(encrypt, records, {
      includeAttachments: this.includeAttachments,
    });
    const ownIndex = new Map(ownRows.map((r) => [r.i, r]));

    // 2. 拉云端
    const sources = await this.pullRows();

    // 3. 合并（本机作为其中一个来源，用自身的 deviceId 参与定序）
    const merged = mergeSources([{ deviceId: meta.deviceId, rows: ownRows }, ...sources]);

    // 4. 找出「云端确实比本机新」的行。
    //    这里必须是严格大于：时间戳相同就是同一个版本，不必重复落库。
    const incoming = [];
    for (const [id, row] of merged) {
      const own = ownIndex.get(id);
      if (!own || compareRows(row, own) > 0) incoming.push(row);
    }

    // 5. 解出有效行（解不开的丢弃：不是本账库的数据，或者被篡改过）
    const valid = [];
    let rejected = 0;
    for (const row of incoming) {
      const payload = await decodeRow(decrypt, row);
      if (payload) valid.push({ row, payload });
      else rejected += 1;
    }

    if (!dryRun && valid.length) {
      await this.local.apply(valid);
    }

    // 6. 写回自己那份日志：内容是「合并后的全量视图」。
    //    判断要不要上传，只看版本集合 (id, 时间戳)——密文每次编码都不同，不能当依据。
    let pushed = 0;
    let skipped = false;
    if (!dryRun) {
      const path = deviceLogPath(meta.deviceId);
      const prevFile = await this.backend.read(path);
      let prev = null;
      if (prevFile) {
        try {
          prev = JSON.parse(prevFile.text);
        } catch {
          prev = null;
        }
      }
      const rows = [...merged.values()];
      if (!prev || versionDigest(prev.rows) !== versionDigest(rows)) {
        const log = makeDeviceLog({
          deviceId: meta.deviceId,
          deviceName: meta.deviceName,
          vaultId: meta.vaultId,
          rows,
          prev,
        });
        await this.backend.write(path, JSON.stringify(log));
        pushed = rows.length;
      } else {
        skipped = true;
      }
    }

    return {
      local_rows: ownRows.length,
      remote_rows: sources.reduce((n, s) => n + s.rows.length, 0),
      merged_rows: merged.size,
      pulled: valid.length,
      rejected,
      pushed,
      unchanged: skipped,
      devices: sources.length,
    };
  }
}

/** 版本集合指纹：只看「哪条记录的哪个版本」，与密文无关，所以是稳定的。 */
function versionDigest(rows) {
  if (!Array.isArray(rows)) return "";
  return rows
    .map((r) => `${r.i}@${r.u}`)
    .sort()
    .join("\n");
}
