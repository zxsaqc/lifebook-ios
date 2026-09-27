// 本机数据层：IndexedDB 持久化 + 应用层加密 + 内存索引。
//
// 关键取舍：
// - **每条记录整体加密后落盘**（不只是敏感字段），落盘内容只有
//   {id, 类型, 时间, 密文}，即使手机被拿到、数据库文件被拷走，没有主口令也解不开。
// - 数据量是个人记账级别（几千条），解锁时全量解密进内存、查询在内存里做，
//   换来「按字段查询也看不到明文」的安全性，代价可以忽略。
// - 主口令派生出的密钥只存在内存变量里，锁定/退出后立刻丢弃，且不可导出。
//
// 存储位置说明：
// - iOS App 内：App 自己的沙盒（卸载 App 才会清除）；
// - 电脑浏览器：该浏览器的站点数据。

import {
  assessPasswordStrength,
  cryptoAvailable,
  decryptString,
  deriveKey,
  encryptString,
  makeVerifier,
  newSalt,
  saltBytes,
  verifyKey,
} from "./crypto.js";

const DB_NAME = "lifebook-vault";
const DB_VERSION = 1;
const STORE_META = "meta";
const STORE_RECORDS = "records";

export const KINDS = [
  "account",
  "transaction",
  "attachment",
  "session",
  "journal",
  "media",
  "rule",
  // 设置项（例如同步用的服务器地址与凭据）。不参与云同步，只留本机。
  "setting",
];

/** 全库内存态。锁定后除 meta 外全部清空。 */
export const vault = {
  key: null,
  unlocked: false,
  initialized: false,
  data: emptyData(),
  meta: {},
};

function emptyData() {
  const out = {};
  for (const k of KINDS) out[k] = [];
  return out;
}

/* ---------------- IndexedDB ---------------- */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "k" });
      }
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, { keyPath: "id" });
        store.createIndex("kind", "kind", { unique: false });
        store.createIndex("kind_updated", ["kind", "updatedAt"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("无法打开本机数据库"));
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        try {
          result = fn(s);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const req = (r) => ({ __req: r });

async function metaGet(k) {
  const v = await tx(STORE_META, "readonly", (s) => req(s.get(k)));
  return v ? v.v : undefined;
}

async function metaSet(k, v) {
  await tx(STORE_META, "readwrite", (s) => s.put({ k, v }));
}

async function allRecords() {
  return (await tx(STORE_RECORDS, "readonly", (s) => req(s.getAll()))) || [];
}

/* ---------------- 工具 ---------------- */

export function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function nowIso() {
  return new Date().toISOString();
}

export function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/* ---------------- 身份 ---------------- */

/** 设备名只是给人看的标签，方便分辨「这条是哪台设备改的」。 */
function guessDeviceName() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  return "本机";
}

/**
 * 读取（必要时生成）账库与设备身份。三者都不是秘密，明文存在 meta 里。
 *
 * - vaultId  标识「这是同一个账库」，同步的两端必须一致；
 * - deviceId 用于在云端占一份只属于自己的日志文件，从结构上避免写冲突；
 * - deviceName 仅用于显示。
 */
async function loadIdentity() {
  let vaultId = await metaGet("vaultId");
  if (!vaultId) {
    vaultId = uid();
    await metaSet("vaultId", vaultId);
  }
  let deviceId = await metaGet("deviceId");
  if (!deviceId) {
    deviceId = uid();
    await metaSet("deviceId", deviceId);
  }
  let deviceName = await metaGet("deviceName");
  if (!deviceName) {
    deviceName = guessDeviceName();
    await metaSet("deviceName", deviceName);
  }
  return { vaultId, deviceId, deviceName };
}

export function identity() {
  return {
    vaultId: vault.meta.vaultId,
    deviceId: vault.meta.deviceId,
    deviceName: vault.meta.deviceName,
  };
}

export async function renameDevice(name) {
  const clean = String(name || "").trim().slice(0, 24);
  if (!clean) throw new LocalError("validation_error", "设备名不能为空");
  vault.meta.deviceName = clean;
  await metaSet("deviceName", clean);
  return clean;
}

/* ---------------- 生命周期 ---------------- */

/** 读元数据判断是否已经设过主口令。 */
export async function init() {
  if (!cryptoAvailable()) {
    throw new Error("SECURE_CONTEXT_REQUIRED");
  }
  // 已经解锁过就不要再走一遍：下面会把内存里的密钥和已解密数据全部清掉，
  // 重复调用等于把用户刚设好的密钥悄悄弄丢（症状是「明明刚解锁却提示已锁定」）。
  // 界面上「先创建主口令、再查询状态」就是这条路径。
  if (vault.unlocked && vault.key) return vault.initialized;

  const salt = await metaGet("salt");
  const verifier = await metaGet("verifier");
  const ident = await loadIdentity();
  vault.initialized = Boolean(salt && verifier);
  vault.meta = { salt, verifier, prefs: (await metaGet("prefs")) || {}, ...ident };
  vault.unlocked = false;
  vault.key = null;
  vault.data = emptyData();
  return vault.initialized;
}

/** 首次创建主口令。 */
export async function setup(password) {
  const strength = assessPasswordStrength(password);
  if (password.length < 8 || strength.score < 2) {
    throw new LocalError("weak_password", "口令强度不足：至少 8 位且包含字母和数字");
  }
  const salt = newSalt();
  const key = await deriveKey(password, saltBytes(salt));
  const verifier = await makeVerifier(key);
  const ident = await loadIdentity();
  await metaSet("salt", salt);
  await metaSet("verifier", verifier);
  vault.meta = { salt, verifier, prefs: {}, ...ident };
  vault.initialized = true;
  vault.key = key;
  vault.unlocked = true;
  vault.data = emptyData();
  return true;
}

/** 用主口令解锁：校验通过后把全库解密进内存。 */
export async function unlock(password) {
  if (!vault.initialized) throw new LocalError("not_initialized", "尚未设置主口令，请先创建");
  const key = await deriveKey(password, saltBytes(vault.meta.salt));
  const ok = await verifyKey(key, vault.meta.verifier);
  if (!ok) throw new LocalError("invalid_credential", "主口令不正确");

  vault.key = key;
  const rows = await allRecords();
  const data = emptyData();
  const undecryptable = [];
  for (const row of rows) {
    try {
      const plain = await decryptString(key, row.blob);
      const obj = JSON.parse(plain);
      if (data[row.kind]) data[row.kind].push(obj);
    } catch {
      undecryptable.push(row.id);
    }
  }
  vault.data = data;
  vault.unlocked = true;
  return { unlocked: true, broken: undecryptable.length };
}

/** 锁定：密钥与明文一起丢弃。 */
export function lock() {
  vault.key = null;
  vault.unlocked = false;
  vault.data = emptyData();
}

export function prefs() {
  return vault.meta.prefs || {};
}

export async function savePrefs(patch) {
  const next = { ...(vault.meta.prefs || {}), ...patch };
  vault.meta.prefs = next;
  await metaSet("prefs", next);
  return next;
}

/* ---------------- 读写 ---------------- */

function requireKey() {
  if (!vault.unlocked || !vault.key) {
    throw new LocalError("vault_locked", "账库已锁定，请重新解锁");
  }
  return vault.key;
}

/** 写一条记录：更新内存 + 加密落盘。 */
export async function put(kind, obj) {
  const key = requireKey();
  const list = vault.data[kind];
  if (!list) throw new Error(`未知数据类型 ${kind}`);
  const idx = list.findIndex((x) => x.id === obj.id);
  if (idx >= 0) list[idx] = obj;
  else list.push(obj);
  const blob = await encryptString(key, JSON.stringify(obj));
  await tx(STORE_RECORDS, "readwrite", (s) =>
    s.put({ id: obj.id, kind, updatedAt: obj.updated_at || obj.updatedAt || nowIso(), blob })
  );
  return obj;
}

export async function putMany(kind, objs) {
  for (const o of objs) await put(kind, o);
}

/** 物理删除（软删除由业务层打标记）。 */
export async function hardDelete(id) {
  requireKey();
  for (const kind of KINDS) {
    const list = vault.data[kind];
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
  }
  await tx(STORE_RECORDS, "readwrite", (s) => s.delete(id));
}

export async function hardDeleteMany(ids) {
  for (const id of ids) await hardDelete(id);
}

/** 读取某类全部（含已软删除，由调用方过滤）。 */
export function list(kind) {
  requireKey();
  return vault.data[kind] || [];
}

/* ---------------- 同步支撑 ---------------- */

/** 当前账库密钥的加解密操作，交给同步引擎使用（密钥本身不外传）。 */
export function cryptoOps() {
  const key = requireKey();
  return {
    encrypt: (plain) => encryptString(key, plain),
    decrypt: (cipher) => decryptString(key, cipher),
  };
}

/**
 * 全部明文记录，按类别分组。仅用于同步时重新编码，不对外暴露。
 *
 * 刻意**排除 setting**：那里面放着同步服务器的地址与凭据，属于本机私事，
 * 不该跟着账库一起上云。多一层排除，以后就算有人往同步类别里加东西也不会误传。
 */
export function localRecords() {
  requireKey();
  const out = {};
  for (const kind of KINDS) {
    if (kind === "setting") continue;
    out[kind] = vault.data[kind] || [];
  }
  return out;
}

/**
 * 把云端行落到本机。
 *
 * 因为两台设备共享同一个账库密钥，落盘时**不需要重新加密**——直接 put() 即可，
 * put() 会顺手写好内存索引和密文。
 */
export async function applyRows(items) {
  requireKey();
  const stats = { upsert: 0, skipped: 0 };
  for (const { row, payload } of items) {
    const kind = payload?.k;
    const record = payload?.r;
    if (!kind || !vault.data[kind] || !record || record.id !== row.i) {
      stats.skipped += 1;
      continue;
    }
    await put(kind, record);
    stats.upsert += 1;
  }
  return stats;
}

/**
 * 加入已有账库：改用云端账库的 salt 重新派生密钥。
 *
 * 这一步是整个同步方案的关键。两台设备各自随机生成 salt，所以同一个主口令
 * 会在两台设备上派生出**不同的密钥**，谁也解不开谁的数据。加入时统一成云端
 * 的 salt，之后两台设备才算共用一把钥匙。
 *
 * salt 一旦改变，本机原先的密文就作废了，必须用新密钥整体重写一遍——
 * 好在解锁状态下明文就在内存里，不需要用户重新输入。
 */
export async function adoptVault({ salt, verifier, vaultId, password }) {
  if (!salt || !verifier || !vaultId) {
    throw new LocalError("bad_state", "云端账库信息不完整");
  }
  const key = await deriveKey(password, saltBytes(salt));
  if (!(await verifyKey(key, verifier))) {
    throw new LocalError(
      "invalid_credential",
      "主口令与云端账库不一致，请确认两台设备用的是同一个主口令"
    );
  }

  const sameSalt = vault.meta.salt === salt;
  const carried = vault.data;
  const ident = await loadIdentity();

  vault.key = key;
  vault.unlocked = true;
  vault.initialized = true;
  // 注意先展开 ident 再覆盖 vaultId：ident 里带的是**本机原来**的 vaultId，
  // 展开顺序反了会把刚写入的云端 vaultId 又冲掉。
  vault.meta = {
    ...vault.meta,
    ...ident,
    vaultId,
    salt,
    verifier,
    prefs: vault.meta.prefs || {},
  };
  await metaSet("salt", salt);
  await metaSet("verifier", verifier);
  await metaSet("vaultId", vaultId);

  if (sameSalt) return { rekeyed: false, rows: 0 };

  let rows = 0;
  const existing = await allRecords();
  await tx(STORE_RECORDS, "readwrite", (s) => {
    for (const r of existing) s.delete(r.id);
  });
  vault.data = emptyData();
  for (const kind of KINDS) {
    for (const record of carried[kind] || []) {
      await put(kind, record);
      rows += 1;
    }
  }
  return { rekeyed: true, rows };
}

/* ---------------- 设置项（加密存储，不参与云同步） ---------------- */

export function getSetting(id, fallback = null) {
  requireKey();
  const found = (vault.data.setting || []).find((s) => s.id === id);
  return found ? clone(found.value ?? null) : clone(fallback);
}

export async function putSetting(id, value) {
  requireKey();
  const existing = (vault.data.setting || []).find((s) => s.id === id);
  const now = nowIso();
  const obj = {
    id,
    value,
    created_at: existing?.created_at || now,
    updated_at: now,
    deleted_at: null,
  };
  await put("setting", obj);
  return obj;
}

/* ---------------- 备份 ---------------- */

/**
 * 导出备份。
 *
 * 备份自带独立 salt 并随文携带，因此可以拿到另一台设备上恢复——
 * 不像主口令的 salt 绑定在这一台机器上。备份内容用备份口令加密，
 * 明文永不出现，可以放心粘到备忘录或发给自己。
 */
export async function exportBackup(password) {
  requireKey();
  if (!password || password.length < 6) {
    throw new LocalError("weak_password", "备份口令至少 6 位");
  }
  const salt = newSalt();
  const key = await deriveKey(password, saltBytes(salt));
  const payload = {
    format: "lifebook-backup",
    version: 1,
    exported_at: nowIso(),
    data: vault.data,
  };
  const cipher = await encryptString(key, JSON.stringify(payload));
  return JSON.stringify({ s: salt, c: cipher });
}

/** 导入：解开备份并覆盖当前库（用当前主口令重新加密落盘）。 */
export async function importBackup(password, backupText) {
  requireKey();
  let salt;
  let cipher;
  try {
    const parsed = JSON.parse(String(backupText || "").trim());
    salt = parsed.s;
    cipher = parsed.c;
  } catch {
    throw new LocalError("validation_error", "备份内容无法识别，请确认完整复制");
  }
  if (!salt || !cipher) throw new LocalError("validation_error", "备份内容缺少必要字段");

  const key = await deriveKey(password, saltBytes(salt));
  const plain = await decryptString(key, cipher);
  const payload = JSON.parse(plain);
  if (payload.format !== "lifebook-backup") throw new LocalError("validation_error", "备份格式不正确");

  const rows = await allRecords();
  await tx(STORE_RECORDS, "readwrite", (s) => {
    for (const r of rows) s.delete(r.id);
  });
  vault.data = emptyData();
  for (const [kind, items] of Object.entries(payload.data || {})) {
    if (!vault.data[kind]) continue;
    for (const item of items) await put(kind, item);
  }
  return true;
}

export class LocalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 估算占用空间（IndexedDB 里存的是密文，略大于明文）。 */
export async function usage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0 };
    }
  } catch {
    /* 拿不到就算了 */
  }
  return { usage: 0, quota: 0 };
}
