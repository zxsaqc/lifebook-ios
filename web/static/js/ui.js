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
