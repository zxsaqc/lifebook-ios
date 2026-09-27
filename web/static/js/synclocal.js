// 同步服务层：把同步引擎 接到本机数据层，并管理同步配置。
//
// 分两步是为了让界面能把「连通性」和「账库身份」分开告诉用户：
//   1. syncConfigure()  填地址账号 → 只测能不能连上（还不碰账库）
//   2. syncInspect()    看云端有没有账库、是不是同一个
//      云端没有        → syncPublish()  首次上传
//      云端是同一个    → syncRun()      直接同步
//      云端是别的账库  → syncAdopt()    加入（需要重新输入主口令）
//
// 为什么加入时要重新输主口令：两台设备各自随机生成 salt，同一个主口令派生出的
// 密钥并不相同。要共用一把钥匙，必须用**云端账库的 salt** 重新派生一次，
// 而这需要主口令原文——它从不落盘，所以只能请用户再输一次。

import {
  adoptVault,
  applyRows,
  cryptoOps,
  getSetting,
  identity,
  localRecords,
  putSetting,
  vault,
} from "./localstore.js";
import { SyncEngine, SyncError, WebDavBackend, evaluateRepo } from "./sync.js";

const SYNC_SETTING_ID = "sync";

const DEFAULT_CONFIG = {
  baseUrl: "",
  // 账号密码加密存在本机（setting 记录整体加密，不参与云同步）
  username: "",
  password: "",
  includeAttachments: false,
  lastSyncAt: "",
  lastResult: "",
};

export function loadSyncConfig() {
  return { ...DEFAULT_CONFIG, ...(getSetting(SYNC_SETTING_ID, {}) || {}) };
}

export async function saveSyncConfig(patch) {
  const next = { ...loadSyncConfig(), ...patch };
  await putSetting(SYNC_SETTING_ID, next);
  return next;
}

/** 是否已经填好可用的同步配置。 */
export function isConfigured() {
  const cfg = loadSyncConfig();
  return Boolean(cfg.baseUrl && cfg.username);
}

export function syncStatus() {
  const cfg = loadSyncConfig();
  const ident = identity();
  return {
    configured: Boolean(cfg.baseUrl && cfg.username),
    base_url: cfg.baseUrl || "",
    username: cfg.username || "",
    include_attachments: !!cfg.includeAttachments,
    last_sync_at: cfg.lastSyncAt || "",
    last_result: cfg.lastResult || "",
    device_id: ident.deviceId,
    device_name: ident.deviceName,
    vault_id: ident.vaultId,
  };
}

function makeBackend(cfg) {
  const conf = cfg || loadSyncConfig();
  if (!conf.baseUrl || !conf.username) {
    throw new SyncError("not_configured", "还没有配置同步服务器");
  }
  return new WebDavBackend({
    baseUrl: conf.baseUrl,
    username: conf.username,
    password: conf.password,
  });
}

/** 本机数据层适配器。crypto 每次现取，所以换过密钥后自动用新的。 */
function adapter() {
  return {
    get meta() {
      return {
        ...identity(),
        salt: vault.meta.salt,
        verifier: vault.meta.verifier,
      };
    },
    crypto: {
      encrypt: (plain) => cryptoOps().encrypt(plain),
      decrypt: (cipher) => cryptoOps().decrypt(cipher),
    },
    records: () => localRecords(),
    apply: (items) => applyRows(items),
  };
}

function makeEngine(cfg) {
  const conf = cfg || loadSyncConfig();
  return new SyncEngine({
    backend: makeBackend(conf),
    local: adapter(),
    includeAttachments: !!conf.includeAttachments,
  });
}

/* ---------------- 1. 配置与连通性 ---------------- */

export async function syncConfigure({ baseUrl, username, password, includeAttachments } = {}) {
  const url = String(baseUrl || "").trim();
  if (!url) throw new SyncError("bad_config", "请填写 WebDAV 地址");
  if (!/^https?:\/\//i.test(url)) {
    throw new SyncError("bad_config", "地址需要以 http:// 或 https:// 开头");
  }
  const prev = loadSyncConfig();
  // 密码留空 = 沿用已经保存的那个。否则每次点「保存并检查」都要重新输一遍，
  // 而且不小心留空还会把已存的密码抹掉。
  const keepSecret = password === undefined || password === null || password === "";
  const secret = keepSecret ? prev.password : String(password);
  const user = username === undefined || username === null ? prev.username : String(username);

  const backend = new WebDavBackend({ baseUrl: url, username: user, password: secret });
  await backend.probe(); // 账号密码不对会在这里就报出来
  await saveSyncConfig({
    baseUrl: url,
    username: user,
    password: secret,
    ...(includeAttachments === undefined ? {} : { includeAttachments: !!includeAttachments }),
  });
  return syncStatus();
}

/* ---------------- 2. 看清云端状况 ---------------- */

export async function syncInspect() {
  const engine = makeEngine();
  const manifest = await engine.readManifest();
  return evaluateRepo(manifest, identity().vaultId);
}

/* ---------------- 3. 首次上传 / 加入 / 同步 ---------------- */

export async function syncPublish({ includeAttachments } = {}) {
  if (includeAttachments !== undefined) await saveSyncConfig({ includeAttachments: !!includeAttachments });
  const engine = makeEngine();
  const result = await engine.publish({ deviceName: identity().deviceName });
  await saveSyncConfig({
    lastSyncAt: new Date().toISOString(),
    lastResult: describe(result),
  });
  return result;
}

/**
 * 加入云端已有的账库。需要主口令原文用于按云端的 salt 重新派生密钥。
 * 返回 {rekeyed, rows} 说明本机是否重写过密文。
 */
export async function syncAdopt({ masterPassword }) {
  if (!masterPassword) throw new SyncError("invalid_credential", "请输入主口令");
  const engine = makeEngine();
  const manifest = await engine.readManifest();
  if (!manifest) throw new SyncError("no_repo", "云端还没有账库，请改用「首次上传」");

  const state = evaluateRepo(manifest, identity().vaultId);
  let rekey = { rekeyed: false, rows: 0 };
  if (!state.same_vault) {
    rekey = await adoptVault({
      salt: manifest.salt,
      verifier: manifest.verifier,
      vaultId: manifest.vault_id,
      password: masterPassword,
    });
  }
  // 换过密钥后要重新建引擎：适配器现在会读到新的 vault.key
  const result = await makeEngine().sync();
  await saveSyncConfig({
    lastSyncAt: new Date().toISOString(),
    lastResult: describe(result),
  });
  return { ...result, ...rekey };
}

/** 清掉本机的同步配置。云端那份仓库不动，其它设备仍然可以继续用。 */
export async function deleteSyncConfig() {
  await saveSyncConfig({ baseUrl: "", username: "", password: "", lastSyncAt: "", lastResult: "" });
  return syncStatus();
}

export async function syncRun() {
  const engine = makeEngine();
  const result = await engine.sync();
  await saveSyncConfig({
    lastSyncAt: new Date().toISOString(),
    lastResult: describe(result),
  });
  return result;
}

function describe(result) {
  const bits = [`拉取 ${result.pulled} 条`];
  if (result.pushed) bits.push(`上传 ${result.pushed} 条`);
  else if (result.unchanged) bits.push("云端无需更新");
  if (result.rejected) bits.push(`跳过 ${result.rejected} 条`);
  return bits.join("，");
}

/** 云端各设备的记录情况，用于同步面板显示。 */
export async function syncDevices() {
  const engine = makeEngine();
  const manifest = await engine.readManifest();
  if (!manifest) return { has_repo: false, devices: [] };
  const sets = await engine.pullRows();
  const devices = sets.map((rows) => ({
    rows: rows.length,
  }));
  return { has_repo: true, device_count: sets.length, devices };
}
