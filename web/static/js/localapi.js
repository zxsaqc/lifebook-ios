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
  importBackup,
  init,
  list,
  lock as lockVault,
  nowIso,
  prefs,
  put,
  savePrefs,
  setup as setupVault,
  uid,
  unlock as unlockVault,
  usage,
  vault,
} from "./localstore.js";

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
};

export class ApiError extends Error {
  constructor(code, message, status, details) {
    super(message || ERROR_MESSAGES[code] || "操作失败");
    this.code = code;
    this.status = status === undefined ? STATUS_BY_CODE[code] || 400 : status;
    this.details = details || {};
  }
  get friendly() {
    return ERROR_MESSAGES[this.code] || this.message || "操作失败，请稍后重试";
  }
}

/** 把内部错误统一转成 ApiError，视图层无需感知实现细节。 */
function wrap(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof LocalError) throw new ApiError(err.code, err.message);
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
};

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

/** 打开 App 时调用：确保数据层就绪。 */
export async function bootstrapLocalData() {
  return init();
}
