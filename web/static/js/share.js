// 加密分享包。
//
// 场景：想把某个月账单、影视清单发给别人看一眼，但不希望对方拿到主口令、
// 也不希望内容在微信/邮件里裸奔。
//
// 做法：用**独立的一次性口令**临时派生一把密钥，只加密挑出来的那部分内容，
// 生成一段自包含的文本。对方只需要这段文本 + 你口头/另外告诉他的分享口令。
//
// 为什么不用主口令：主口令能解开你的全部数据（包括账号密码、工资），
// 一旦给出就等于把账库交出去了。分享包用的是另一把密钥，解不出分享范围外的东西。
//
// 分享包里带了独立的 salt（和账号主口令的 salt 无关），所以对方在**任何设备**上
// 都能打开，不需要先装 App。
//
// 注意：分享包是「离线」的——一旦生成就不再受你控制，别人可以转发。
// 所以默认带有效期，过期后即使有口令也拒绝打开（有效期写在明处，便于提前拒绝）。

import { decryptString, deriveKey, encryptString, newSalt, saltBytes } from "./crypto.js";

export const SHARE_FORMAT = "lifebook-share";
export const SHARE_VERSION = 1;

export class ShareError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 生成分享包。
 *
 * @param {string} password 分享口令（至少 6 位，最好单独约定，别用主口令）
 * @param {object} opts
 * @param {object} opts.data   要分享的内容，形如 { transaction: [...], media: [...] }
 * @param {string} opts.note   给对方的说明，比如「9 月账单」
 * @param {number} opts.ttlDays 有效期天数；传 0 表示不过期
 * @param {string} opts.fromDevice 来源设备名，仅作说明
 * @returns {Promise<string>} 一段可直接粘贴的文本
 */
export async function buildShare(password, { data, note = "", ttlDays = 7, fromDevice = "" } = {}) {
  if (!password || password.length < 6) {
    throw new ShareError("weak_password", "分享口令至少 6 位");
  }
  const kinds = data && typeof data === "object" ? data : {};
  const total = Object.values(kinds).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  if (!total) throw new ShareError("empty_share", "没有可分享的内容");

  const now = new Date();
  const expiresAt =
    ttlDays > 0 ? new Date(now.getTime() + ttlDays * 86400000).toISOString() : "";

  const salt = newSalt();
  const key = await deriveKey(password, saltBytes(salt));
  const payload = {
    format: "lifebook-share-payload",
    version: SHARE_VERSION,
    note,
    from_device: fromDevice,
    created_at: now.toISOString(),
    expires_at: expiresAt,
    counts: Object.fromEntries(
      Object.entries(kinds).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
    ),
    data: kinds,
  };
  const cipher = await encryptString(key, JSON.stringify(payload));

  return JSON.stringify({
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    kdf: { algo: "PBKDF2-SHA256", rounds: 250000 },
    cipher: "AES-256-GCM",
    salt,
    // 有效期放在明处：过期就直接拒绝，不必先做 25 万轮派生
    expires_at: expiresAt,
    payload: cipher,
  });
}

/** 不需要口令就能看到的头信息，用于在打开前提示「这是什么、过期没」。 */
export function peekShare(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || "").trim());
  } catch {
    throw new ShareError("bad_share", "分享内容无法识别，请确认完整复制");
  }
  if (parsed.format !== SHARE_FORMAT) {
    throw new ShareError("bad_share", "这不是 LifeBook 的分享内容");
  }
  const expired = isExpired(parsed.expires_at);
  return { expires_at: parsed.expires_at || "", expired, version: parsed.version };
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && Date.now() > t;
}

/**
 * 打开分享包。
 *
 * @returns {Promise<{data: object, note: string, created_at: string, expires_at: string,
 *                    counts: object, from_device: string}>}
 */
export async function readShare(password, text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || "").trim());
  } catch {
    throw new ShareError("bad_share", "分享内容无法识别，请确认完整复制");
  }
  if (parsed.format !== SHARE_FORMAT) throw new ShareError("bad_share", "这不是 LifeBook 的分享内容");
  if (!parsed.salt || !parsed.payload) throw new ShareError("bad_share", "分享内容缺少必要字段");
  if (isExpired(parsed.expires_at)) {
    throw new ShareError("share_expired", "这个分享已过期，请让对方重新生成");
  }

  const key = await deriveKey(password, saltBytes(parsed.salt));
  let payload;
  try {
    payload = JSON.parse(await decryptString(key, parsed.payload));
  } catch {
    throw new ShareError("invalid_credential", "分享口令不正确");
  }
  if (payload.format !== "lifebook-share-payload") {
    throw new ShareError("bad_share", "分享内容格式不正确");
  }
  // 密文里那份有效期和明处对不上，说明被改过
  if ((payload.expires_at || "") !== (parsed.expires_at || "")) {
    throw new ShareError("share_tampered", "分享内容被修改过，已拒绝打开");
  }
  return payload;
}

/** 从账单里挑出某个月的记录，供分享用。 */
export function pickMonth(transactions, month) {
  const m = String(month || "").slice(0, 7);
  return (transactions || []).filter((t) => String(t.paid_at || "").startsWith(m));
}

/** 把记录裁剪成适合分享的字段（去掉内部标记、AI 调试字段）。 */
export function slimRecords(kind, records) {
  const pick = {
    transaction: ["paid_at", "merchant", "amount_minor", "currency", "category",
      "direction", "method", "idea", "feeling", "notes", "tags", "is_subscription", "period"],
    media: ["title", "kind", "status", "rating", "watched_on", "director", "year",
      "season", "episode", "review", "thoughts", "tags"],
    session: ["day", "project", "minutes", "mood", "content", "tags"],
    journal: ["day", "mood", "summary", "highlights", "tags"],
    account: ["platform", "category", "username", "url", "notes", "tags"],
  }[kind];
  if (!pick) return (records || []).map((r) => ({ ...r }));
  return (records || []).map((r) => {
    const out = {};
    for (const f of pick) if (r[f] !== undefined) out[f] = r[f];
    return out;
  });
}
