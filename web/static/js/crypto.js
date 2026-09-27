// 密码学原语：主口令派生密钥 + 认证加密。
//
// 设计要点（与后端 security.py 等价，但跑在浏览器/App 里）：
// - 主口令本身永不落盘，只保存随机 salt 与「校验密文」；
// - 密钥由 PBKDF2-HMAC-SHA256 派生（25 万轮），算法为 AES-256-GCM（带认证，防篡改）；
// - 派生出的密钥只活在内存里，锁定 / 刷新后自动失效，谁也拿不回。

const ROUNDS = 250000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const VERIFIER_TEXT = "lifebook-vault-v1";
const PREFIX = "v1";

export function cryptoAvailable() {
  return (
    typeof crypto !== "undefined" &&
    typeof crypto.subtle !== "undefined" &&
    typeof crypto.subtle.importKey === "function" &&
    typeof crypto.getRandomValues === "function"
  );
}

export function randomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function b64e(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64d(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** PBKDF2-SHA256 → AES-256-GCM 密钥（不可导出，防止被脚本读取）。 */
export async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ROUNDS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** 加密字符串；空串直接返回空串（保持与后端 encrypt() 一致）。 */
export async function encryptString(key, plaintext) {
  if (!plaintext) return "";
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${PREFIX}:${b64e(iv)}:${b64e(new Uint8Array(ct))}`;
}

/** 解密字符串；密钥不对或密文被改动都会抛错。 */
export async function decryptString(key, payload) {
  if (!payload) return "";
  const parts = String(payload).split(":");
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    throw new Error("密文格式无法识别");
  }
  const iv = b64d(parts[1]);
  const data = b64d(parts[2]);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("解密失败：主口令不匹配或数据已损坏");
  }
}

export async function makeVerifier(key) {
  return encryptString(key, VERIFIER_TEXT);
}

/** 用「能否解开校验密文」判断主口令是否正确。 */
export async function verifyKey(key, verifier) {
  try {
    const plain = await decryptString(key, verifier);
    return plain === VERIFIER_TEXT;
  } catch {
    return false;
  }
}

export function newSalt() {
  return b64e(randomBytes(SALT_BYTES));
}

export function saltBytes(text) {
  return b64d(text);
}

/** 口令强度评分（0-4），与后端 assess_password_strength 规则一致。 */
export function assessPasswordStrength(password) {
  const pw = password || "";
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[0-9]/.test(pw) && /[a-zA-Z]/.test(pw)) score += 1;
  if (/[^0-9a-zA-Z]/.test(pw)) score += 1;
  const labels = { 0: "极弱", 1: "弱", 2: "一般", 3: "较强", 4: "强" };
  return { score, label: labels[score] };
}
