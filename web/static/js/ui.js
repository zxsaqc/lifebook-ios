// 通用 UI 工具：转义、格式化、Toast、底部弹层、确认框。
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function nowMonth() {
  return today().slice(0, 7);
}

export function nowDateTimeLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function prettyDate(text) {
  if (!text) return "";
  const d = new Date(text.includes("T") ? text : `${text}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(text);
  const t = today();
  if (text.startsWith(t)) return `今天 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (String(text).startsWith(y)) return "昨天";
  const s = String(text).slice(0, 10);
  return s.slice(5).replace("-", "/");
}

export function money(minorOrString) {
  const num = typeof minorOrString === "number" ? minorOrString / 100 : Number(minorOrString || 0);
  return `¥${num.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function moneyShort(value) {
  const n = Number(value || 0);
  if (n >= 10000) return `¥${(n / 10000).toFixed(1)}万`;
  return `¥${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

export function hoursText(minutes) {
  return `${(minutes / 60).toFixed(1)}h`;
}

export function toast(message, kind = "", ms = 2400) {
  const host = $("#toast-host");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** iOS 风格底部弹层：bodyHtml 由调用方生成，submit 回调收到内部表单元素集合 */
export function openSheet({ title, bodyHtml, submitText = "保存", onSubmit, extraButton }) {
  const host = $("#sheet-host");
  host.innerHTML = `
    <div class="mask">
      <div class="sheet">
        <div class="grabber"></div>
        <div class="sheet-head">
          <h3>${esc(title)}</h3>
          <button class="btn ghost sm" data-close>关闭</button>
        </div>
        <form novalidate>
          ${bodyHtml}
          <div style="display:flex;gap:10px;margin-top:6px">
            ${extraButton ? `<button type="button" class="btn ghost" data-extra>${esc(extraButton)}</button>` : ""}
            <button type="submit" class="btn block">${esc(submitText)}</button>
          </div>
        </form>
      </div>
    </div>`;
  const mask = $(".mask", host);
  const form = $("form", host);

  const close = () => { host.innerHTML = ""; };
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  $("[data-close]", host).addEventListener("click", close);
  const extraEl = $("[data-extra]", host);
  if (extraEl) extraEl.addEventListener("click", () => window.dispatchEvent(new CustomEvent("sheet:extra")));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", form);
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      await onSubmit(form);
      close();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      throw err;
    }
  });
  return { close, form };
}

export function confirmDialog(title, message, dangerText = "删除") {
  return new Promise((resolve) => {
    const host = $("#sheet-host");
    const done = (v) => { host.innerHTML = ""; resolve(v); };
    host.innerHTML = `
      <div class="center-mask">
        <div class="dialog">
          <h3>${esc(title)}</h3>
          <p>${esc(message)}</p>
          <div class="dlg-btns">
            <button class="btn ghost" data-no>取消</button>
            <button class="btn danger" data-yes>${esc(dangerText)}</button>
          </div>
        </div>
      </div>`;
    $("[data-no]", host).addEventListener("click", () => done(false));
    $("[data-yes]", host).addEventListener("click", () => done(true));
    $(".center-mask", host).addEventListener("click", (e) => {
      if (e.target.classList.contains("center-mask")) done(false);
    });
  });
}

/** 星级选择器：返回 0-10（半星粒度由调用方按 2 递增） */
export function starPickerHtml(name = "rating", value = 0) {
  let html = `<div class="star-picker" data-stars data-target="${name}">`;
  for (let i = 1; i <= 5; i++) {
    const v = i * 2;
    html += `<span data-v="${v}" class="${value >= v ? "on" : ""}">★</span>`;
  }
  html += `</div><input type="hidden" name="${name}" value="${value}" />`;
  return html;
}

export function bindStarPicker(root) {
  const wrap = $("[data-stars]", root);
  if (!wrap) return;
  const input = $("input[type=hidden]", root);
  wrap.addEventListener("click", (e) => {
    const star = e.target.closest("[data-v]");
    if (!star) return;
    const v = Number(star.dataset.v);
    const current = Number(input.value);
    const next = current === v ? v - 1 : v; // 再点一次给半星/取消
    input.value = String(Math.max(0, next));
    $$("[data-v]", wrap).forEach((el) => {
      el.classList.toggle("on", Number(el.dataset.v) <= Number(input.value));
    });
  });
}

/* ---------------- 图标 ----------------
   统一一套线条图标，而不是用 emoji：
   emoji 由各平台字体决定长相，iPhone 上是彩色的、安卓上是另一套、Windows 又是第三套，
   同一排里风格互相打架。这里的图标走 currentColor，颜色由外层的 .ico-tile 决定。
   新增图标只需往下面的表里加一条路径，注意画布固定 20×20。 */

const ICONS = {
  today:
    '<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.2V10l2.6 1.8"/>',
  card: '<rect x="2.8" y="4.6" width="14.4" height="10.8" rx="2.4"/><path d="M2.8 8.4h14.4"/>',
  key: '<circle cx="7.2" cy="10" r="3.2"/><path d="M10.4 10H17"/><path d="M14.2 10v2.6"/>',
  film: '<rect x="2.6" y="4.8" width="14.8" height="10.4" rx="2"/><path d="M8.4 7.9l4 2.1-4 2.1z" fill="currentColor" stroke="none"/>',
  receipt:
    '<path d="M5 2.8h10v14.4l-2.5-1.6-2.5 1.6-2.5-1.6L5 17.2z"/><path d="M8 7.4h4"/><path d="M8 10.6h4"/>',
  bookmark: '<path d="M5.6 3.2h8.8v13.6l-4.4-3.2-4.4 3.2z"/>',
  sun: '<circle cx="10" cy="10" r="3.5"/><path d="M10 2.8v1.8M10 15.4v1.8M2.8 10h1.8M15.4 10h1.8M5.1 5.1l1.3 1.3M13.6 13.6l1.3 1.3M14.9 5.1l-1.3 1.3M6.4 13.6l-1.3 1.3"/>',
  sparkle: '<path d="M10 3.4l1.6 4.9 4.9 1.6-4.9 1.6L10 16.6l-1.6-4.9L3.5 10l4.9-1.7z"/>',
};

/** 取一枚图标。name 不存在时回退到 today，不会渲染出空白。 */
export function icon(name, size = 20) {
  const body = ICONS[name] || ICONS.today;
  return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** 淡色底 + 同色系线条的方块图标，列表行左侧用。tint 取 brand/expense/income/amber/violet */
export function iconTile(name, tint = "brand", size = 18) {
  return `<span class="ico-tile tint-${tint}">${icon(name, size)}</span>`;
}

/** 空状态用的大号图标 */
export function emptyIcon(name, size = 32) {
  return `<span class="empty-ico">${icon(name, size)}</span>`;
}

export const ICON_NAMES = Object.keys(ICONS);
