// 统一 API 客户端：错误映射、加载态、重试策略。
// Base URL 同源；若前后端分离部署，可在 index.html 注入 window.__API_BASE__。

const BASE_URL = window.__API_BASE__ || "";

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
  rate_limited: "操作过于频繁，请稍后再试",
  dependency_error: "依赖服务暂不可用",
  internal_error: "服务内部错误，请稍后重试",
  offline: "连接不到本机服务，请确认 LifeBook 已启动",
};

export class ApiError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details || {};
  }
  get friendly() {
    return ERROR_MESSAGES[this.code] || this.message || "请求失败，请稍后重试";
  }
}

const RETRYABLE = new Set([502, 503, 504]);
const MAX_RETRY = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, path, { body, params, retry = 0 } = {}) {
  let url = BASE_URL + path;
  if (params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") usp.append(k, v);
    }
    const qs = usp.toString();
    if (qs) url += `?${qs}`;
  }
  const init = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (retry < MAX_RETRY) {
      await sleep(280 * (retry + 1));
      return request(method, path, { body, params, retry: retry + 1 });
    }
    throw new ApiError("offline", ERROR_MESSAGES.offline, 0);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  if (!res.ok) {
    const errBody = payload?.error || {};
    const error = new ApiError(errBody.code || "internal_error", errBody.message, res.status, errBody.details);
    if (res.status >= 500 && RETRYABLE.has(res.status) && retry < MAX_RETRY) {
      await sleep(280 * (retry + 1));
      return request(method, path, { body, params, retry: retry + 1 });
    }
    throw error;
  }
  return payload;
}

async function upload(path, file) {
  const form = new FormData();
  form.append("file", file);
  let res;
  try {
    res = await fetch(BASE_URL + path, { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    throw new ApiError("offline", ERROR_MESSAGES.offline, 0);
  }
  const text = await res.text();
  let payload = null;
  if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }
  if (!res.ok) {
    const e = payload?.error || {};
    throw new ApiError(e.code || "internal_error", e.message, res.status);
  }
  return payload;
}

const get = (p, o) => request("GET", p, o);
const post = (p, b, o) => request("POST", p, { ...o, body: b });
const patch = (p, b, o) => request("PATCH", p, { ...o, body: b });
const put = (p, b, o) => request("PUT", p, { ...o, body: b });
const del = (p, o) => request("DELETE", p, o);

export const api = {
  // 认证
  authState: () => get("/api/auth/state"),
  setup: (masterPassword) => post("/api/auth/setup", { master_password: masterPassword }),
  login: (masterPassword) => post("/api/auth/login", { master_password: masterPassword }),
  unlock: (masterPassword) => post("/api/auth/unlock", { master_password: masterPassword }),
  lock: () => post("/api/auth/lock", {}),
  logout: () => post("/api/auth/logout", {}),

  // 账号本子
  listAccounts: (params) => get("/api/accounts", { params }),
  accountCategories: () => get("/api/accounts/categories"),
  accountStats: () => get("/api/accounts/stats"),
  createAccount: (p) => post("/api/accounts", p),
  updateAccount: (id, p) => patch(`/api/accounts/${id}`, p),
  revealAccount: (id) => post(`/api/accounts/${id}/reveal`, {}),
  deleteAccount: (id) => del(`/api/accounts/${id}`),

  // 记账
  ledgerCategories: () => get("/api/ledger/categories"),
  ledgerPreview: (merchant, amount) => post("/api/ledger/preview", { merchant, amount }),
  ledgerStats: (month) => get("/api/ledger/stats", { params: { month } }),
  listTransactions: (params) => get("/api/ledger/transactions", { params }),
  createTransaction: (p) => post("/api/ledger/transactions", p),
  updateTransaction: (id, p) => patch(`/api/ledger/transactions/${id}`, p),
  deleteTransaction: (id) => del(`/api/ledger/transactions/${id}`),
  getTransaction: (id) => get(`/api/ledger/transactions/${id}`),
  uploadReceipt: (id, file) => upload(`/api/ledger/transactions/${id}/attachments`, file),
  removeAttachment: (txId, attId) => del(`/api/ledger/transactions/${txId}/attachments/${attId}`),

  // 工时
  dayHours: (day) => get("/api/hours/today", { params: { day } }),
  hoursStats: (days) => get("/api/hours/stats", { params: { days } }),
  createSession: (p) => post("/api/hours/sessions", p),
  updateSession: (id, p) => patch(`/api/hours/sessions/${id}`, p),
  deleteSession: (id) => del(`/api/hours/sessions/${id}`),
  saveJournal: (p) => put("/api/hours/journal", p),
  journals: (limit) => get("/api/hours/journals", { params: { limit } }),

  // 影视
  mediaMeta: () => get("/api/media/meta"),
  mediaStats: () => get("/api/media/stats"),
  listMedia: (params) => get("/api/media/items", { params }),
  createMedia: (p) => post("/api/media/items", p),
  updateMedia: (id, p) => patch(`/api/media/items/${id}`, p),
  deleteMedia: (id) => del(`/api/media/items/${id}`),
};
