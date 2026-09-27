// 本机版 API：所有数据只在当前设备上，不联网、不依赖任何服务器。
//
// 对外接口与原后端完全一致（同名方法、同结构返回），因此上层视图代码一行都不用改。
// 业务规则（AI 打标、统计口径、软删除、规则学习）与后端逐条对齐。

import { assessPasswordStrength } from "./crypto.js";
import {
  CATEGORY_LABELS,
  LEDGER_CATEGORIES,
  analyze,
  monthlyCost,
  normalizeMerchant,
} from "./rules.js";
import {
  LocalError,
  clone,
  exportBackup,
  hardDelete,
  hardDeleteMany,
  identity,
  importBackup,
  init,
  list,
  lock as lockVault,
  nowIso,
  prefs,
  put,
  renameDevice,
  savePrefs,
  setup as setupVault,
  uid,
  unlock as unlockVault,
  usage,
  vault,
} from "./localstore.js";
import { ShareError, buildShare, peekShare, readShare, slimRecords } from "./share.js";
import { SyncError } from "./sync.js";
import {
  IMPORT_SOURCES,
  MODULES,
  analyzeInput,
  describeRecord,
} from "./importers.js";
import {
  deleteSyncConfig,
  syncAdopt,
  syncConfigure,
  syncInspect,
  syncPublish,
  syncRun,
  syncStatus,
} from "./synclocal.js";

const ERROR_MESSAGES = {
  validation_error: "提交的数据不合法，请检查后重试",
  invalid_credential: "主口令不正确",
  unauthorized: "会话已过期，请重新进入",
  vault_locked: "账库已锁定，请重新解锁",
  already_initialized: "主口令已设置，请直接登录",
  not_initialized: "尚未设置主口令，请先创建",
  weak_password: "口令强度不足：至少 8 位且包含字母和数字",
  not_found: "找不到对应记录，可能已被删除",
  conflict: "存在重复记录",
  duplicate_entry: "已存在相同记录",
  offline: "本机数据不可用，请重试",
  secure_context_required: "当前环境不支持加密存储，请通过 App 或本机地址打开",
  empty_import: "没有从内容里认出可导入的记录，请检查格式或手动指定模块",
  // 云同步
  not_configured: "还没有配置同步服务器",
  bad_config: "服务器地址或账号格式不对，请检查",
  backend_error: "同步服务器拒绝了这次请求，请稍后重试",
  transport_error: "连不上同步服务器，请检查地址与网络",
  no_repo: "云端还没有账库，请先「首次上传」",
  vault_mismatch: "本机账库与云端账库不是同一个",
  bad_repo: "这个目录不是 LifeBook 的同步目录",
  bad_state: "账库状态不完整，请重新解锁后再试",
  bad_device_id: "设备标识不合法",
  // 分享
  share_expired: "这个分享已过期，请让对方重新生成",
  share_tampered: "分享内容被修改过，已拒绝打开",
  empty_share: "所选范围内没有可分享的内容",
  bad_share: "这不是 LifeBook 的分享内容",
};

const STATUS_BY_CODE = {
  validation_error: 422,
  invalid_credential: 401,
  unauthorized: 401,
  vault_locked: 409,
  not_initialized: 409,
  already_initialized: 409,
  weak_password: 422,
  not_found: 404,
  conflict: 409,
  duplicate_entry: 409,
  secure_context_required: 500,
  not_configured: 409,
  bad_config: 422,
  no_repo: 404,
  vault_mismatch: 409,
  bad_repo: 422,
  bad_state: 409,
  share_expired: 410,
  share_tampered: 422,
  empty_share: 422,
  bad_share: 422,
};

export class ApiError extends Error {
  constructor(code, message, status, details) {
    super(message || ERROR_MESSAGES[code] || "操作失败");
    this.code = code;
    this.status = status === undefined ? STATUS_BY_CODE[code] || 400 : status;
    this.details = details || {};
  }
  get friendly() {
    // 显式给出的说明优先于通用文案：同样是 weak_password，
    // 「备份口令至少 6 位」比「至少 8 位且包含字母和数字」有用得多。
    return this.message || ERROR_MESSAGES[this.code] || "操作失败，请稍后重试";
  }
}

/** 把内部错误统一转成 ApiError，视图层无需感知实现细节。 */
function wrap(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof LocalError || err instanceof SyncError || err instanceof ShareError) {
        throw new ApiError(err.code, err.message);
      }
      if (err && err.message === "SECURE_CONTEXT_REQUIRED") {
        throw new ApiError("secure_context_required", ERROR_MESSAGES.secure_context_required, 500);
      }
      throw new ApiError("internal_error", err?.message || "本机操作失败", 500);
    }
  };
}

/* ---------------- 通用工具 ---------------- */

const pad = (n) => String(n).padStart(2, "0");

/** 本地时间 ISO（不带 Z）。所有时间都按本地时间存，避免跨时区把「今天」算错。 */
export function localIso(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function localDay(d = new Date()) {
  return localIso(d).slice(0, 10);
}

function amountDisplay(minor) {
  return (minor / 100).toFixed(2);
}

/** 金额字符串 → 分；非法直接抛校验错误（后端 _to_minor 等价）。 */
function toMinor(amount) {
  const n = Number.parseFloat(String(amount ?? "").trim());
  if (!Number.isFinite(n)) throw new ApiError("validation_error", "金额格式不正确");
  return Math.round(n * 100);
}

function starsOf(rating) {
  return "★".repeat(Math.floor(rating / 2)) + (rating % 2 ? "☆" : "");
}

function cleanTags(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  const out = [];
  for (const raw of arr) {
    const t = String(raw || "").trim();
    if (!t) continue;
    if (t.length > 24) throw new ApiError("validation_error", "单个标签不超过 24 字");
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > 12) throw new ApiError("validation_error", "标签最多 12 个");
  return out;
}

const alive = (rows) => rows.filter((r) => !r.deleted_at);

/* ---------------- 账号本子 ---------------- */

const ACCOUNT_CATEGORIES = {
  social: "社交", email: "邮箱", finance: "金融支付", dev: "开发运维", work: "办公协作",
  gaming: "游戏娱乐", shopping: "电商购物", subscription: "会员订阅", education: "学习教育",
  other: "其他",
};

function accountOut(e) {
  return {
    id: e.id,
    platform: e.platform,
    category: e.category,
    category_label: ACCOUNT_CATEGORIES[e.category] || "其他",
    username: e.username,
    url: e.url,
    notes: e.notes,
    tags: e.tags || [],
    is_favorite: !!e.is_favorite,
    password_set: !!e.password,
    password_strength: e.password_strength || 0,
    totp_set: !!e.totp_secret,
    password_updated_at: e.password_updated_at || null,
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

function findAccount(id) {
  const found = list("account").find((x) => x.id === id && !x.deleted_at);
  if (!found) throw new ApiError("not_found", "账号记录不存在或已删除");
  return found;
}

function hasDuplicate(platform, username, excludeId) {
  const p = String(platform || "").trim().toLowerCase();
  const u = String(username || "").trim().toLowerCase();
  return alive(list("account")).some(
    (e) =>
      e.id !== excludeId &&
      String(e.platform || "").trim().toLowerCase() === p &&
      String(e.username || "").trim().toLowerCase() === u
  );
}

/* ---------------- 记账 ---------------- */

function txOut(t, attachments) {
  const reasons = t.ai_reasons || [];
  const ai = {
    category: t.category,
    category_label: CATEGORY_LABELS[t.category] || "其他",
    is_subscription: !!t.is_subscription,
    period: t.period || "",
    confidence: t.ai_confidence || 0,
    reasons,
    matched_service: t.merchant,
    applied: !!t.ai_applied,
  };
  return {
    id: t.id,
    direction: t.direction,
    amount: amountDisplay(t.amount_minor),
    amount_minor: t.amount_minor,
    currency: t.currency || "CNY",
    merchant: t.merchant,
    category: t.category,
    category_label: CATEGORY_LABELS[t.category] || "其他",
    method: t.method,
    idea: t.idea,
    feeling: t.feeling,
    notes: t.notes,
    tags: t.tags || [],
    paid_at: t.paid_at,
    is_subscription: !!t.is_subscription,
    period: t.period || "",
    monthly_cost: t.is_subscription ? monthlyCost(t.amount_minor, t.period) : 0,
    ai,
    attachments: (attachments || []).map(attachmentOut),
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function attachmentOut(a) {
  return {
    id: a.id,
    file_name: a.file_name,
    mime: a.mime,
    size: a.size,
    width: a.width,
    height: a.height,
    url: a.url,
    thumb_url: a.thumb_url,
  };
}

function findTx(id) {
  const found = list("transaction").find((x) => x.id === id && !x.deleted_at);
  if (!found) throw new ApiError("not_found", "账单不存在或已删除");
  return found;
}

function attachmentsOf(txId) {
  return alive(list("attachment")).filter((a) => a.transaction_id === txId);
}

function historiesFor(merchant) {
  const norm = normalizeMerchant(merchant);
  if (!norm) return [];
  return alive(list("transaction"))
    .filter((t) => normalizeMerchant(t.merchant) === norm)
    .slice(-6)
    .map((t) => ({ amountMinor: t.amount_minor }));
}

function upsertRule(merchant, category, isSubscription, period) {
  const norm = normalizeMerchant(merchant);
  if (!norm) return;
  const existing = list("rule").find((r) => r.id === norm);
  const obj = {
    id: norm,
    merchant_norm: norm,
    category,
    is_subscription: !!isSubscription,
    period: period || "",
    updated_at: nowIso(),
    created_at: existing?.created_at || nowIso(),
  };
  put("rule", obj);
}

function ruleMap() {
  const out = {};
  for (const r of list("rule")) out[r.id] = r;
  return out;
}

function monthOf(iso) {
  return String(iso || "").slice(0, 7);
}

function ledgerTotals(month, full = false) {
  const rows = alive(list("transaction")).filter((t) => monthOf(t.paid_at) === month);
  const expense = rows.filter((t) => t.direction !== "income").reduce((s, t) => s + t.amount_minor, 0);
  const income = rows.filter((t) => t.direction === "income").reduce((s, t) => s + t.amount_minor, 0);

  const byCat = {};
  for (const t of rows) {
    if (t.direction === "income") continue;
    byCat[t.category] = Math.round(((byCat[t.category] || 0) + t.amount_minor / 100) * 100) / 100;
  }
  const topEntry = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];

  const subs = alive(list("transaction")).filter((t) => t.is_subscription && t.direction !== "income");

  const data = {
    month,
    expense_total: amountDisplay(expense),
    income_total: amountDisplay(income),
    net: amountDisplay(income - expense),
    by_category: byCat,
    subscription_monthly_cost: Math.round(subs.reduce((s, t) => s + monthlyCost(t.amount_minor, t.period), 0) * 100) / 100,
    subscription_count: subs.length,
    top_category: topEntry ? topEntry[0] : "none",
  };

  if (full) {
    const applied = rows.filter((t) => t.ai_applied).length;
    data.ai_hit_rate = rows.length ? Math.round((applied / rows.length) * 1000) / 10 : 0;

    const days = [];
    const today = new Date();
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const key = localDay(d);
      const sum = alive(list("transaction"))
        .filter((t) => t.direction !== "income" && String(t.paid_at).slice(0, 10) === key)
        .reduce((s, t) => s + t.amount_minor, 0);
      days.push({ day: key, amount: Math.round((sum / 100) * 100) / 100 });
    }
    data.recent_days = days;
  }
  return data;
}

/* ---------------- 图片压缩（凭证照片） ---------------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ApiError("validation_error", "图片无法读取"));
    };
    img.src = url;
  });
}

function shrink(img, maxSize, quality) {
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL("image/jpeg", quality), width: w, height: h };
}

/* ---------------- 导出 API ---------------- */

/**
 * 打开本机数据库只需要一次；缓存 Promise，避免并发调用重复初始化
 * （重复 init 会把已解锁的密钥冲掉）。
 */
let initPromise = null;
function ensureInit() {
  if (!initPromise) {
    initPromise = init().catch((err) => {
      initPromise = null; // 失败允许重试
      throw err;
    });
  }
  return initPromise;
}

export const api = {
  /* -------- 鉴权 -------- */
  authState: wrap(async () => {
    await ensureInit();
    return {
      vault_initialized: vault.initialized,
      locked: !vault.unlocked,
    };
  }),

  setup: wrap(async (masterPassword) => {
    await setupVault(masterPassword);
    return { ok: true };
  }),

  login: wrap(async (masterPassword) => {
    await unlockVault(masterPassword);
    return { ok: true };
  }),

  unlock: wrap(async (masterPassword) => {
    await unlockVault(masterPassword);
    return { ok: true };
  }),

  lock: wrap(async () => {
    lockVault();
    return { ok: true };
  }),

  logout: wrap(async () => {
    lockVault();
    return { ok: true };
  }),

  /* -------- 账号本子 -------- */
  listAccounts: wrap(async (params = {}) => {
    const { q = "", category = "", tag = "", favorite = false, sort = "updated_at" } = params;
    let limit = Number(params.limit || 50);
    let offset = Number(params.offset || 0);
    limit = Math.max(1, Math.min(limit, 200));
    offset = Math.max(0, offset);

    const kw = String(q).toLowerCase();
    let rows = alive(list("account"));
    if (kw) {
      rows = rows.filter((e) =>
        [e.platform, e.username, e.url, e.notes].some((f) => String(f || "").toLowerCase().includes(kw))
      );
    }
    if (category) rows = rows.filter((e) => e.category === category);
    if (tag) rows = rows.filter((e) => (e.tags || []).includes(tag));
    if (favorite) rows = rows.filter((e) => e.is_favorite);

    const cmp = {
      updated_at: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)),
      created_at: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
      platform: (a, b) => String(a.platform).localeCompare(String(b.platform), "zh-Hans-CN"),
    }[sort] || ((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    rows = [...rows].sort(cmp);

    return {
      items: rows.slice(offset, offset + limit).map(accountOut),
      total: rows.length,
      limit,
      offset,
    };
  }),

  accountCategories: wrap(async () =>
    Object.entries(ACCOUNT_CATEGORIES).map(([key, label]) => ({ key, label }))
  ),

  accountStats: wrap(async () => {
    const rows = alive(list("account"));
    const byCategory = {};
    for (const e of rows) byCategory[e.category] = (byCategory[e.category] || 0) + 1;

    const groups = {};
    for (const e of rows) {
      if (!e.username) continue;
      const key = `${e.platform}\u0000${e.username}`;
      groups[key] = (groups[key] || 0) + 1;
    }

    return {
      total: rows.length,
      by_category: byCategory,
      weak_password_count: rows.filter((e) => (e.password_strength || 0) <= 1).length,
      no_password_count: rows.filter((e) => !e.password).length,
      duplicate_username_groups: Object.values(groups).filter((n) => n > 1).length,
    };
  }),

  createAccount: wrap(async (payload) => {
    const platform = String(payload.platform || "").trim();
    if (!platform) throw new ApiError("validation_error", "平台名称不能为空");
    const category = payload.category || "other";
    if (!ACCOUNT_CATEGORIES[category]) throw new ApiError("validation_error", `未知分类：${category}`);
    const username = payload.username || "";
    if (hasDuplicate(platform, username)) {
      throw new ApiError("duplicate_entry", `「${platform}」下已存在同名账号 ${username || "(空)"}`);
    }
    const now = nowIso();
    const password = payload.password || "";
    const obj = {
      id: uid(),
      platform,
      category,
      username,
      password,
      totp_secret: payload.totp_secret || "",
      url: payload.url || "",
      notes: payload.notes || "",
      tags: cleanTags(payload.tags),
      is_favorite: !!payload.is_favorite,
      password_strength: password ? assessPasswordStrength(password).score : 0,
      password_updated_at: password ? now : null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await put("account", obj);
    return accountOut(obj);
  }),

  updateAccount: wrap(async (id, payload) => {
    const entity = findAccount(id);
    const keys = Object.keys(payload || {});
    if (!keys.length) throw new ApiError("validation_error", "没有需要更新的字段");

    if ("platform" in payload || "username" in payload) {
      const platform = payload.platform ?? entity.platform;
      const username = payload.username ?? entity.username;
      if (!String(platform).trim()) throw new ApiError("validation_error", "平台名称不能为空");
      if (hasDuplicate(platform, username, id)) {
        throw new ApiError("duplicate_entry", `「{platform}」下已存在同名账号`.replace("{platform}", platform));
      }
    }
    if ("category" in payload && !ACCOUNT_CATEGORIES[payload.category]) {
      throw new ApiError("validation_error", `未知分类：${payload.category}`);
    }

    if ("password" in payload) {
      const pw = payload.password || "";
      entity.password = pw;
      entity.password_strength = pw ? assessPasswordStrength(pw).score : 0;
      entity.password_updated_at = pw ? nowIso() : null;
    }
    if ("totp_secret" in payload) entity.totp_secret = payload.totp_secret || "";
    for (const f of ["platform", "category", "username", "url", "notes", "is_favorite"]) {
      if (f in payload) entity[f] = payload[f];
    }
    if ("tags" in payload) entity.tags = cleanTags(payload.tags);

    entity.updated_at = nowIso();
    await put("account", entity);
    return accountOut(entity);
  }),

  revealAccount: wrap(async (id) => {
    const e = findAccount(id);
    return { id: e.id, password: e.password || "", totp_secret: e.totp_secret || "" };
  }),

  deleteAccount: wrap(async (id) => {
    const e = findAccount(id);
    e.deleted_at = nowIso();
    e.updated_at = e.deleted_at;
    await put("account", e);
    return null;
  }),

  /* -------- 记账 -------- */
  ledgerCategories: wrap(async () =>
    LEDGER_CATEGORIES.map((key) => ({ key, label: CATEGORY_LABELS[key] }))
  ),

  ledgerPreview: wrap(async (merchant, amount) => {
    const minor = toMinor(amount);
    return analyze({
      merchant,
      amountMinor: minor,
      learned: ruleMap(),
      history: historiesFor(merchant),
    });
  }),

  ledgerStats: wrap(async (month) => ledgerTotals(month || localDay().slice(0, 7), true)),

  listTransactions: wrap(async (params = {}) => {
    const { month = "", category = "", q = "", subscription = false, direction = "" } = params;
    let limit = Number(params.limit || 20);
    let offset = Number(params.offset || 0);
    limit = Math.max(1, Math.min(limit, 100));
    offset = Math.max(0, offset);

    const kw = String(q).toLowerCase();
    let rows = alive(list("transaction"));
    if (month) rows = rows.filter((t) => monthOf(t.paid_at) === month);
    if (category) rows = rows.filter((t) => t.category === category);
    if (subscription) rows = rows.filter((t) => t.is_subscription);
    if (direction) rows = rows.filter((t) => t.direction === direction);
    if (kw) {
      rows = rows.filter((t) =>
        [t.merchant, t.idea, t.feeling, t.notes].some((f) => String(f || "").toLowerCase().includes(kw))
      );
    }
    rows = [...rows].sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)));

    const items = rows.slice(offset, offset + limit).map((t) => txOut(t, attachmentsOf(t.id)));
    return {
      items,
      total: rows.length,
      limit,
      offset,
      totals: ledgerTotals(month || localDay().slice(0, 7)),
    };
  }),

  createTransaction: wrap(async (payload) => {
    const amountMinor = toMinor(payload.amount);
    if (amountMinor <= 0) throw new ApiError("validation_error", "金额必须大于 0");

    const merchant = payload.merchant || "";
    const paidAt = payload.paid_at || localIso();
    const manual = payload.category === undefined ? null : payload.category;
    const useAi = payload.use_ai !== false;

    let ai = { category: "other", is_subscription: false, period: "", confidence: 0, reasons: [] };
    if (useAi) {
      ai = analyze({
        merchant,
        amountMinor,
        learned: ruleMap(),
        history: historiesFor(merchant),
      });
    }

    const finalCategory = manual || ai.category;
    const isSubscription = manual === null ? !!ai.is_subscription : manual === "subscription";
    const aiApplied = manual === null && (!!ai.is_subscription || ai.confidence >= 0.5);
    const now = nowIso();

    const obj = {
      id: uid(),
      direction: payload.direction || "expense",
      amount_minor: amountMinor,
      currency: payload.currency || "CNY",
      merchant,
      category: finalCategory,
      method: payload.method || "",
      idea: payload.idea || "",
      feeling: payload.feeling || "",
      notes: payload.notes || "",
      tags: cleanTags(payload.tags),
      paid_at: paidAt,
      is_subscription: isSubscription,
      period: isSubscription ? ai.period || "" : "",
      ai_confidence: ai.confidence || 0,
      ai_reasons: ai.reasons || [],
      ai_applied: aiApplied,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await put("transaction", obj);

    if (manual && merchant) {
      upsertRule(merchant, manual, manual === "subscription", manual === "subscription" ? "monthly" : "");
    }
    const out = txOut(obj, []);
    out.ai = { ...out.ai, ...ai, applied: aiApplied };
    return out;
  }),

  updateTransaction: wrap(async (id, payload) => {
    const t = findTx(id);
    if (!payload || !Object.keys(payload).length) {
      throw new ApiError("validation_error", "没有需要更新的字段");
    }
    if ("amount" in payload) {
      const minor = toMinor(payload.amount);
      if (minor <= 0) throw new ApiError("validation_error", "金额必须大于 0");
      t.amount_minor = minor;
    }
    if ("category" in payload) {
      t.category = payload.category;
      t.ai_applied = false;
      if (t.merchant) {
        upsertRule(
          t.merchant,
          payload.category,
          payload.category === "subscription",
          payload.period || ""
        );
      }
    }
    if ("is_subscription" in payload) t.is_subscription = !!payload.is_subscription;
    if ("period" in payload) t.period = payload.period || "";
    for (const f of ["direction", "currency", "merchant", "method", "idea", "feeling", "notes"]) {
      if (f in payload) t[f] = payload[f];
    }
    if ("tags" in payload) t.tags = cleanTags(payload.tags);
    if ("paid_at" in payload && payload.paid_at) t.paid_at = payload.paid_at;

    t.updated_at = nowIso();
    await put("transaction", t);
    return txOut(t, attachmentsOf(id));
  }),

  deleteTransaction: wrap(async (id) => {
    const t = findTx(id);
    t.deleted_at = nowIso();
    t.updated_at = t.deleted_at;
    await put("transaction", t);
    const atts = attachmentsOf(id);
    await hardDeleteMany(atts.map((a) => a.id));
    return null;
  }),

  getTransaction: wrap(async (id) => txOut(findTx(id), attachmentsOf(id))),

  uploadReceipt: wrap(async (id, file) => {
    findTx(id);
    const img = await loadImage(file);
    const full = shrink(img, 1400, 0.82);
    const thumb = shrink(img, 320, 0.72);
    const obj = {
      id: uid(),
      transaction_id: id,
      file_name: file.name || "receipt.jpg",
      mime: "image/jpeg",
      size: Math.round((full.dataUrl.length * 3) / 4),
      width: full.width,
      height: full.height,
      url: full.dataUrl,
      thumb_url: thumb.dataUrl,
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    };
    await put("attachment", obj);
    return attachmentOut(obj);
  }),

  removeAttachment: wrap(async (txId, attId) => {
    const att = alive(list("attachment")).find((a) => a.id === attId && a.transaction_id === txId);
    if (!att) throw new ApiError("not_found", "附件不存在");
    await hardDelete(attId);
    return null;
  }),

  /* -------- 工时 -------- */
  dayHours: wrap(async (day) => {
    const target = day || localDay();
    const sessions = alive(list("session"))
      .filter((s) => s.day === target)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const journal = alive(list("journal")).find((j) => j.day === target) || null;
    return {
      day: target,
      sessions: sessions.map(sessionOut),
      journal: journal ? journalOut(journal) : null,
      total_minutes: sessions.reduce((s, x) => s + x.minutes, 0),
    };
  }),

  hoursStats: wrap(async (days) => {
    const n = Number(days || 30);
    if (!(n >= 1 && n <= 366)) throw new ApiError("validation_error", "统计区间需在 1~366 天之间");
    const end = new Date();
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (n - 1));
    const startKey = localDay(start);
    const endKey = localDay(end);

    const rows = alive(list("session")).filter((s) => s.day >= startKey && s.day <= endKey);
    const total = rows.reduce((s, x) => s + x.minutes, 0);

    const byProject = {};
    for (const s of rows) byProject[s.project] = (byProject[s.project] || 0) + s.minutes;

    const journals = alive(list("journal")).filter((j) => j.day >= startKey && j.day <= endKey);
    const moodAvg = journals.length
      ? Math.round((journals.reduce((s, j) => s + (j.mood || 0), 0) / journals.length) * 10) / 10
      : 0;

    const daily = {};
    for (const s of rows) daily[s.day] = (daily[s.day] || 0) + s.minutes;
    const dayKeys = Object.keys(daily).sort();

    // 连续记录天数：从今天往前数
    const recorded = new Set(alive(list("session")).map((s) => s.day));
    let streak = 0;
    const cursor = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (recorded.has(localDay(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    return {
      range_days: n,
      total_minutes: total,
      total_hours: (total / 60).toFixed(1),
      avg_minutes_per_day: (total / n).toFixed(1),
      active_days: dayKeys.length,
      streak_days: streak,
      by_project: byProject,
      avg_mood: moodAvg,
      recent_days: dayKeys.slice(-14).map((d) => ({ day: d, minutes: daily[d] })),
    };
  }),

  createSession: wrap(async (payload) => {
    const minutes = Number(payload.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new ApiError("validation_error", "工时必须大于 0");
    if (minutes > 1440) throw new ApiError("validation_error", "单段工时不能超过 24 小时");
    const project = String(payload.project || "").trim();
    if (!project) throw new ApiError("validation_error", "项目名不能为空");
    const mood = Number(payload.mood || 3);
    if (mood < 1 || mood > 5) throw new ApiError("validation_error", "心情需在 1~5 之间");

    const now = nowIso();
    const obj = {
      id: uid(),
      day: payload.day || localDay(),
      project,
      minutes,
      mood,
      content: payload.content || "",
      tags: cleanTags(payload.tags),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await put("session", obj);
    return sessionOut(obj);
  }),

  updateSession: wrap(async (id, payload) => {
    const s = alive(list("session")).find((x) => x.id === id);
    if (!s) throw new ApiError("not_found", "工时记录不存在");
    if (!payload || !Object.keys(payload).length) {
      throw new ApiError("validation_error", "没有需要更新的字段");
    }
    for (const f of ["day", "project", "minutes", "mood", "content"]) {
      if (f in payload) s[f] = payload[f];
    }
    if ("tags" in payload) s.tags = cleanTags(payload.tags);
    if (s.minutes > 1440) throw new ApiError("validation_error", "单段工时不能超过 24 小时");
    s.updated_at = nowIso();
    await put("session", s);
    return sessionOut(s);
  }),

  deleteSession: wrap(async (id) => {
    const s = alive(list("session")).find((x) => x.id === id);
    if (!s) throw new ApiError("not_found", "工时记录不存在");
    s.deleted_at = nowIso();
    s.updated_at = s.deleted_at;
    await put("session", s);
    return null;
  }),

  saveJournal: wrap(async (payload) => {
    const day = payload.day || localDay();
    const existing = alive(list("journal")).find((j) => j.day === day);
    const mood = Number(payload.mood ?? existing?.mood ?? 3);
    if (mood < 1 || mood > 5) throw new ApiError("validation_error", "心情需在 1~5 之间");
    const obj = {
      id: existing?.id || uid(),
      day,
      mood,
      summary: payload.summary ?? existing?.summary ?? "",
      highlights: payload.highlights ?? existing?.highlights ?? "",
      tags: "tags" in payload ? cleanTags(payload.tags) : existing?.tags || [],
      created_at: existing?.created_at || nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    };
    await put("journal", obj);
    return journalOut(obj);
  }),

  journals: wrap(async (limit) => {
    const n = Math.max(1, Number(limit || 10));
    return alive(list("journal"))
      .sort((a, b) => String(b.day).localeCompare(String(a.day)))
      .slice(0, n)
      .map(journalOut);
  }),

  /* -------- 影视 -------- */
  mediaMeta: wrap(async () => ({
    kinds: Object.entries(MEDIA_KINDS).map(([key, label]) => ({ key, label })),
    statuses: Object.entries(MEDIA_STATUSES).map(([key, label]) => ({ key, label })),
  })),

  mediaStats: wrap(async () => {
    const rows = alive(list("media"));
    const byKind = {};
    const byStatus = {};
    for (const m of rows) {
      byKind[m.kind] = (byKind[m.kind] || 0) + 1;
      byStatus[m.status] = (byStatus[m.status] || 0) + 1;
    }
    const rated = rows.filter((m) => m.rating > 0);
    const year = String(new Date().getFullYear());
    return {
      total: rows.length,
      by_kind: byKind,
      by_status: byStatus,
      watched_this_year: rows.filter(
        (m) => m.status === "done" && String(m.watched_on || "").startsWith(year)
      ).length,
      avg_rating: rated.length
        ? Math.round((rated.reduce((s, m) => s + m.rating, 0) / rated.length) * 10) / 10
        : 0,
      top_rated: rated
        .slice()
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 5)
        .map((m) => ({ title: m.title, rating: m.rating, kind: MEDIA_KINDS[m.kind] || "" })),
    };
  }),

  listMedia: wrap(async (params = {}) => {
    const { kind = "", status = "", keyword = "", minRating = 0, sort = "updated_at" } = params;
    let limit = Number(params.limit || 30);
    let offset = Number(params.offset || 0);
    limit = Math.max(1, Math.min(limit, 100));
    offset = Math.max(0, offset);

    const kw = String(keyword).toLowerCase();
    let rows = alive(list("media"));
    if (kind) rows = rows.filter((m) => m.kind === kind);
    if (status) rows = rows.filter((m) => m.status === status);
    if (minRating) rows = rows.filter((m) => m.rating >= Number(minRating));
    if (kw) {
      rows = rows.filter((m) =>
        [m.title, m.director, m.review, m.thoughts].some((f) =>
          String(f || "").toLowerCase().includes(kw)
        )
      );
    }
    const cmp = {
      watched_on: (a, b) => String(b.watched_on || "").localeCompare(String(a.watched_on || "")),
      rating: (a, b) => b.rating - a.rating,
      title: (a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"),
      updated_at: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)),
    }[sort] || ((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    rows = [...rows].sort(cmp);

    return {
      items: rows.slice(offset, offset + limit).map(mediaOut),
      total: rows.length,
      limit,
      offset,
    };
  }),

  createMedia: wrap(async (payload) => {
    const title = String(payload.title || "").trim();
    if (!title) throw new ApiError("validation_error", "片名不能为空");
    const kind = payload.kind || "movie";
    if (!MEDIA_KINDS[kind]) throw new ApiError("validation_error", `未知类型：${kind}`);
    const status = payload.status || "done";
    if (!MEDIA_STATUSES[status]) throw new ApiError("validation_error", `未知状态：${status}`);
    const rating = Number(payload.rating || 0);
    if (rating < 0 || rating > 10) throw new ApiError("validation_error", "评分需在 0~10 之间");

    const now = nowIso();
    const obj = {
      id: uid(),
      title,
      kind,
      status,
      rating,
      review: payload.review || "",
      thoughts: payload.thoughts || "",
      director: payload.director || "",
      year: Number(payload.year || 0),
      season: Number(payload.season || 0),
      episode: payload.episode || "",
      watched_on: payload.watched_on || (status === "done" ? localDay() : ""),
      poster_url: payload.poster_url || "",
      tags: cleanTags(payload.tags),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await put("media", obj);
    return mediaOut(obj);
  }),

  updateMedia: wrap(async (id, payload) => {
    const m = alive(list("media")).find((x) => x.id === id);
    if (!m) throw new ApiError("not_found", "影视记录不存在");
    if (!payload || !Object.keys(payload).length) {
      throw new ApiError("validation_error", "没有需要更新的字段");
    }
    if ("kind" in payload && !MEDIA_KINDS[payload.kind]) {
      throw new ApiError("validation_error", `未知类型：${payload.kind}`);
    }
    if ("status" in payload && !MEDIA_STATUSES[payload.status]) {
      throw new ApiError("validation_error", `未知状态：${payload.status}`);
    }
    if ("rating" in payload && (payload.rating < 0 || payload.rating > 10)) {
      throw new ApiError("validation_error", "评分需在 0~10 之间");
    }
    for (const f of ["title", "kind", "status", "rating", "review", "thoughts", "director",
      "year", "season", "episode", "watched_on", "poster_url"]) {
      if (f in payload) m[f] = payload[f];
    }
    if ("tags" in payload) m.tags = cleanTags(payload.tags);
    m.updated_at = nowIso();
    await put("media", m);
    return mediaOut(m);
  }),

  deleteMedia: wrap(async (id) => {
    const m = alive(list("media")).find((x) => x.id === id);
    if (!m) throw new ApiError("not_found", "影视记录不存在");
    m.deleted_at = nowIso();
    m.updated_at = m.deleted_at;
    await put("media", m);
    return null;
  }),

  /* -------- 本机数据管理（App 专属） -------- */
  localUsage: wrap(async () => usage()),
  localExport: wrap(async (password) => ({ payload: await exportBackup(password) })),
  localImport: wrap(async (password, ciphertext) => {
    await importBackup(password, ciphertext);
    return { ok: true };
  }),
  localPrefs: wrap(async () => clone(prefs())),
  localSavePrefs: wrap(async (patch) => savePrefs(patch || {})),

  /* -------- 云同步（App 专属）-------- */
  // 注意：所有数据在离开本机之前就已经加密，服务器上只有密文。
  syncStatus: wrap(async () => syncStatus()),
  syncConfigure: wrap(async (payload = {}) => syncConfigure(payload)),
  syncInspect: wrap(async () => syncInspect()),
  syncPublish: wrap(async (opts = {}) => syncPublish(opts)),
  syncAdopt: wrap(async (opts = {}) => syncAdopt(opts)),
  syncRun: wrap(async () => syncRun()),
  syncDisconnect: wrap(async () => deleteSyncConfig()),
  syncRenameDevice: wrap(async (name) => ({ device_name: await renameDevice(name) })),

  /* -------- 加密分享 -------- */
  sharePreview: wrap(async (payload = {}) => sharePreview(payload)),
  shareCreate: wrap(async (payload = {}) => shareCreate(payload)),
  sharePeek: wrap(async (text) => peekShare(text)),
  shareOpen: wrap(async (password, text) => readShare(password, text)),

  /* -------- 导入中转（把别处导出的数据搬进来）-------- */
  importSources: wrap(async () => ({
    sources: IMPORT_SOURCES,
    modules: Object.entries(MODULES).map(([key, label]) => ({ key, label })),
  })),
  importScan: wrap(async (payload = {}) => importScan(payload)),
  importApply: wrap(async (payload = {}) => importApply(payload)),
};

/** 可以对外分享的类别。账号清单会**自动去掉口令和两步验证密钥**。 */
const SHAREABLE = ["account", "transaction", "session", "journal", "media"];

/** 按类别（可选再按月过滤）挑出要分享的记录，并裁掉内部字段。 */
function collectShareData({ kinds = [], month = "" } = {}) {
  const picked = (Array.isArray(kinds) ? kinds : []).filter((k) => SHAREABLE.includes(k));
  const data = {};
  for (const kind of picked) {
    let rows = alive(list(kind));
    if (month) {
      const m = String(month).slice(0, 7);
      rows = rows.filter((r) =>
        kind === "transaction" ? monthOf(r.paid_at) === m : String(r.day || "").startsWith(m)
      );
    }
    data[kind] = slimRecords(kind, rows);
  }
  return data;
}

function sharePreview(payload) {
  const data = collectShareData(payload);
  const counts = {};
  let total = 0;
  for (const [kind, rows] of Object.entries(data)) {
    counts[kind] = rows.length;
    total += rows.length;
  }
  return { counts, total };
}

async function shareCreate(payload = {}) {
  const data = collectShareData(payload);
  const total = Object.values(data).reduce((n, rows) => n + rows.length, 0);
  if (!total) throw new ApiError("empty_share", "所选范围内没有记录");
  const text = await buildShare(payload.password, {
    data,
    note: payload.note || "",
    ttlDays: Number(payload.ttlDays ?? 7),
    fromDevice: identity().deviceName,
  });
  return { payload: text, total, counts: sharePreview(payload).counts };
}

const MEDIA_KINDS = { movie: "电影", tv: "剧集", doc: "纪录片", anime: "动画" };
const MEDIA_STATUSES = { plan: "想看", watching: "在看", done: "看完", dropped: "弃了" };
const MOOD_LABELS = { 1: "很糟", 2: "低落", 3: "还行", 4: "不错", 5: "很棒" };

function sessionOut(s) {
  return {
    id: s.id,
    day: s.day,
    project: s.project,
    minutes: s.minutes,
    hours: (s.minutes / 60).toFixed(1),
    mood: s.mood,
    mood_label: MOOD_LABELS[s.mood] || "还行",
    content: s.content,
    tags: s.tags || [],
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

function journalOut(j) {
  return {
    day: j.day,
    mood: j.mood,
    mood_label: MOOD_LABELS[j.mood] || "还行",
    summary: j.summary,
    highlights: j.highlights,
    tags: j.tags || [],
    created_at: j.created_at,
    updated_at: j.updated_at,
  };
}

function mediaOut(m) {
  return {
    id: m.id,
    title: m.title,
    kind: m.kind,
    kind_label: MEDIA_KINDS[m.kind] || m.kind,
    status: m.status,
    status_label: MEDIA_STATUSES[m.status] || m.status,
    rating: m.rating,
    stars: starsOf(m.rating),
    review: m.review,
    thoughts: m.thoughts,
    director: m.director,
    year: m.year,
    season: m.season,
    episode: m.episode,
    watched_on: m.watched_on,
    poster_url: m.poster_url,
    tags: m.tags || [],
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

/* ==================== 导入中转 ==================== */

// 导入是「把用户别处的数据搬过来」，有两条硬要求：
// 1. 同一份文件导入两次不能变成两份数据 —— 靠指纹去重，不靠用户自己记得；
// 2. 导入进来的历史账单也要有 AI 分类。否则用户看到几百条「其他」，
//    第一反应是这软件不好用，转头就走 —— 恰恰是推广最怕的结果。

/** 去重指纹：一条记录在不同来源里都稳定可比的那几个特征。 */
function dedupeKey(record) {
  const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "");
  switch (record.kind) {
    case "account":
      return `account|${norm(record.platform)}|${norm(record.username)}`;
    case "transaction":
      return [
        "transaction",
        String(record.paid_at || "").slice(0, 16),
        record.amount_minor,
        norm(record.merchant),
      ].join("|");
    case "session":
      return `session|${record.day}|${norm(record.project)}|${record.minutes}`;
    case "journal":
      // 日记按天唯一，同一天再导入就是覆盖
      return `journal|${record.day}`;
    case "media": {
      const mk = record.media_kind || record.kind || "";
      return `media|${norm(record.title)}|${mk}`;
    }
    default:
      return "";
  }
}

function existingFingerprints(kind) {
  const set = new Set();
  for (const row of alive(list(kind))) set.add(dedupeKey({ ...row, kind }));
  return set;
}

/**
 * 草稿分成「值得导入」与「重复」两堆。同一份文件里的重复也要拦住。
 * 按每条记录自己的类别去比对 —— 分享包可能同时含账号、账单、影视好几种。
 */
function splitFresh(records) {
  const cache = new Map();
  const knownFor = (kind) => {
    if (!cache.has(kind)) cache.set(kind, existingFingerprints(kind));
    return cache.get(kind);
  };
  const fresh = [];
  const duplicate = [];
  for (const record of records) {
    const key = dedupeKey(record);
    const known = record.kind === "setting" ? null : knownFor(record.kind);
    if (!key || (known && known.has(key))) {
      duplicate.push(record);
      continue;
    }
    if (known) known.add(key);
    fresh.push(record);
  }
  return { fresh, duplicate };
}

/** 有些来源导出的是完整的 otpauth:// URI，只取里面的 secret。 */
function cleanTotp(value) {
  const s = String(value || "").trim();
  const m = s.match(/[?&]secret=([A-Za-z0-9=]+)/i);
  return m ? m[1] : s;
}

function withImportTag(tags, on) {
  const out = Array.isArray(tags) ? [...tags] : [];
  // 打上「导入」标签是为了让用户事后能一次找出这批记录，后悔了还能撤销
  if (on && !out.includes("导入")) out.push("导入");
  return out;
}

/** 草稿 → 各模块 createXxx 的入参。 */
function toPayload(record, tag) {
  switch (record.kind) {
    case "account":
      return {
        platform: record.platform,
        category: record.category || "other",
        username: record.username || "",
        password: record.password || "",
        totp_secret: cleanTotp(record.totp_secret),
        url: record.url || "",
        notes: record.notes || "",
        tags: withImportTag(record.tags, tag),
        is_favorite: !!record.is_favorite,
      };
    case "transaction": {
      const payload = {
        direction: record.direction || "expense",
        amount: (record.amount_minor || 0) / 100,
        currency: record.currency || "CNY",
        merchant: record.merchant || "",
        method: record.method || "",
        notes: record.notes || "",
        tags: withImportTag(record.tags, tag),
        paid_at: record.paid_at || localIso(),
      };
      // 来源给了确切分类就沿用；认不出时**不传** category，让 AI 按商户名判定。
      // 这行偷不得：传一个空 category 会把 AI 判定整个关掉。
      if (record.category === "subscription" || record.is_subscription) {
        payload.category = "subscription";
      } else if (record.category && record.category !== "other") {
        payload.category = record.category;
      }
      return payload;
    }
    case "session":
      return {
        day: record.day || localDay(),
        project: record.project,
        minutes: record.minutes,
        mood: record.mood || 3,
        content: record.content || "",
        tags: withImportTag(record.tags, tag),
      };
    case "journal":
      return {
        day: record.day || localDay(),
        mood: record.mood || 3,
        summary: record.summary || "",
        highlights: record.highlights || "",
        tags: withImportTag(record.tags, tag),
      };
    case "media":
      return {
        title: record.title,
        kind: record.media_kind || "movie",
        status: record.status || "done",
        rating: record.rating || 0,
        review: record.review || "",
        thoughts: record.thoughts || "",
        director: record.director || "",
        year: record.year || 0,
        season: record.season || 0,
        episode: record.episode || "",
        watched_on: record.watched_on || "",
        poster_url: record.poster_url || "",
        tags: withImportTag(record.tags, tag),
      };
    default:
      return null;
  }
}

function publicAnalysis(analysis, fresh, duplicate) {
  return {
    shape: analysis.shape,
    module: analysis.module,
    module_label: analysis.moduleLabel,
    confidence: analysis.confidence,
    source: analysis.source,
    warnings: analysis.warnings,
    alternatives: analysis.alternatives,
    stats: {
      total: analysis.stats.total,
      parsed: analysis.stats.parsed,
      skipped: analysis.stats.skipped,
      fresh: fresh.length,
      duplicate: duplicate.length,
    },
    preview: fresh.slice(0, 15).map(describeRecord),
    preview_duplicate: duplicate.slice(0, 3).map(describeRecord),
  };
}

/** 这段文本是不是 LifeBook 分享包（别人分享给你的那种密文）。 */
function looksLikeShare(text) {
  const s = String(text || "").trim();
  if (!s.startsWith("{")) return false;
  try {
    return JSON.parse(s).format === "lifebook-share";
  } catch {
    return false;
  }
}

const KIND_TO_MODULE = {
  account: "account",
  transaction: "ledger",
  session: "hours",
  journal: "hours",
  media: "media",
};

/**
 * 分享包是密文，走的是「口令解密 → 复用里面的记录」，不是字段归一那套。
 * 注意分享包里的账号清单**本来就不带口令** —— 生成分享时就裁掉了，
 * 所以导进来的是账号名和网址，需要自己补密码。
 */
async function shareAnalysis(text, payload) {
  const opened = await readShare(payload.password || "", text);
  const data = opened.data || {};
  const records = [];
  for (const row of data.account || []) {
    records.push({
      kind: "account", platform: row.platform || "未命名", category: row.category || "other",
      username: row.username || "", password: row.password || "", totp_secret: "",
      url: row.url || "", notes: row.notes || "", tags: row.tags || [], is_favorite: false,
    });
  }
  for (const row of data.transaction || []) {
    records.push({
      kind: "transaction", direction: row.direction || "expense",
      amount_minor: row.amount_minor || 0, currency: row.currency || "CNY",
      merchant: row.merchant || "", category: row.category || "", method: row.method || "",
      idea: row.idea || "", feeling: row.feeling || "", notes: row.notes || "",
      tags: row.tags || [], paid_at: row.paid_at || localIso(),
      is_subscription: !!row.is_subscription, period: row.period || "",
    });
  }
  for (const row of data.session || []) {
    records.push({
      kind: "session", day: String(row.day || "").slice(0, 10) || localDay(),
      project: row.project || "未命名项目", minutes: row.minutes || 0,
      mood: row.mood || 3, content: row.content || "", tags: row.tags || [],
    });
  }
  for (const row of data.journal || []) {
    records.push({
      kind: "journal", day: String(row.day || "").slice(0, 10) || localDay(),
      mood: row.mood || 3, summary: row.summary || "", highlights: row.highlights || "",
      tags: row.tags || [],
    });
  }
  for (const row of data.media || []) {
    records.push({
      kind: "media", media_kind: row.kind || "movie", title: row.title || "",
      status: row.status || "done", rating: row.rating || 0, review: row.review || "",
      thoughts: row.thoughts || "", director: row.director || "", year: row.year || 0,
      season: row.season || 0, episode: row.episode || "", watched_on: row.watched_on || "",
      poster_url: "", tags: row.tags || [],
    });
  }

  const kinds = [...new Set(records.map((r) => r.kind))];
  const warnings = ["分享包里的账号清单不含口令（生成时就去掉了），导入后需要自己补上"];
  if (opened.note) warnings.push(`对方留言：${String(opened.note).slice(0, 80)}`);

  return {
    shape: "share",
    module: "",
    moduleLabel: kinds.map((k) => MODULES[KIND_TO_MODULE[k]] || k).join(" / ") || "分享包",
    confidence: 1,
    source: {
      id: "lifebook-share",
      label: "LifeBook 分享包",
      hint: opened.from_device ? `来自 ${opened.from_device}` : "",
    },
    warnings,
    alternatives: [],
    stats: { total: records.length, parsed: records.length, skipped: 0 },
    records,
  };
}

/**
 * 只看不写：识别格式、判断模块、算出会新增多少条、预览前几条。
 * 应该先让用户过一眼再真导 —— 格式认错却直接写库，用户得自己一条条删。
 */
async function importScan(payload = {}) {
  const text = String(payload.text || "");
  if (looksLikeShare(text)) {
    if (!payload.password) throw new ApiError("validation_error", "请先填写这个分享包的口令");
    const analysis = await shareAnalysis(text, payload);
    const { fresh, duplicate } = analysis.records.length
      ? splitFresh(analysis.records)
      : { fresh: [], duplicate: [] };
    return publicAnalysis(analysis, fresh, duplicate);
  }
  const analysis = analyzeInput(text, { module: payload.module || "" });
  const { fresh, duplicate } = analysis.records.length
    ? splitFresh(analysis.records)
    : { fresh: [], duplicate: [] };
  return publicAnalysis(analysis, fresh, duplicate);
}

/** 执行导入。逐条走各模块本来的校验与 AI 打标，不是绕过业务逻辑直接写库。 */
async function importApply(payload = {}) {
  const text = String(payload.text || "");
  if (!text.trim()) throw new ApiError("validation_error", "请先粘贴或选择要导入的内容");

  const analysis = looksLikeShare(text)
    ? (!payload.password
      ? (() => { throw new ApiError("validation_error", "请先填写这个分享包的口令"); })()
      : await shareAnalysis(text, payload))
    : analyzeInput(text, { module: payload.module || "" });

  if (!analysis.records.length) {
    throw new ApiError("empty_import", analysis.warnings[0] || "没有解析出可导入的记录");
  }

  const { fresh, duplicate } = splitFresh(analysis.records);
  const includeDuplicates = payload.include_duplicates === true;
  const records = includeDuplicates ? [...fresh, ...duplicate] : fresh;

  if (!records.length) {
    return {
      ...publicAnalysis(analysis, fresh, duplicate),
      created: { account: 0, transaction: 0, session: 0, journal: 0, media: 0 },
      created_total: 0,
      skipped_duplicate: duplicate.length,
      failed: [],
      nothing_new: true,
    };
  }

  const tag = payload.tag_import !== false;
  const created = { account: 0, transaction: 0, session: 0, journal: 0, media: 0 };
  const failed = [];

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const body = toPayload(record, tag);
    try {
      if (record.kind === "account") await api.createAccount(body);
      else if (record.kind === "transaction") await api.createTransaction(body);
      else if (record.kind === "session") await api.createSession(body);
      else if (record.kind === "journal") await api.saveJournal(body);
      else if (record.kind === "media") await api.createMedia(body);
      else continue;
      created[record.kind] += 1;
    } catch (err) {
      failed.push({
        label: describeRecord(record),
        message: err instanceof ApiError ? err.friendly : (err && err.message) || "导入失败",
      });
    }
    // 批量导入时定期让出事件循环，界面上的「正在导入」才不会看起来像卡死
    if (i % 50 === 49) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const createdTotal = Object.values(created).reduce((n, v) => n + v, 0);
  return {
    ...publicAnalysis(analysis, fresh, duplicate),
    created,
    created_total: createdTotal,
    skipped_duplicate: includeDuplicates ? 0 : duplicate.length,
    failed,
    nothing_new: createdTotal === 0,
  };
}

/** 打开 App 时调用：确保数据层就绪。 */
export async function bootstrapLocalData() {
  return init();
}
