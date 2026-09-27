// 应用入口：鉴权门禁 + 视图路由 + 全局错误映射
import { api, ApiError } from "./api.js";
import { $, $$, esc, today, toast, confirmDialog } from "./ui.js";
import { dashboard } from "./views/dashboard.js";
import { hours } from "./views/hours.js";
import { ledger } from "./views/ledger.js";
import { accounts } from "./views/accounts.js";
import { media } from "./views/media.js";
import { openShareSheet, openSyncSheet } from "./syncui.js";
import { openImportSheet } from "./importui.js";

// 说明：不再注册 Service Worker。
// 数据已经完全在本机，页面资源也由 App 自带的本地服务提供，不需要离线缓存；
// 反而 SW 缓存会导致 App 升级后仍加载旧脚本。若以后要清理历史缓存，见 README。

const views = { dashboard, hours, ledger, accounts, media };
let current = "dashboard";
const mounted = new Set();

/* ---------------- 鉴权 ---------------- */
const AUTH_COPY = {
  setup: { title: "创建主口令", desc: "口令用于加密本机数据，只存在这台设备上，请务必牢记", label: "新主口令", submit: "创建并进入" },
  login: { title: "LifeBook", desc: "输入主口令解锁账库", label: "主口令", submit: "解锁进入" },
  unlock: { title: "账库已锁定", desc: "输入主口令重新解锁", label: "主口令", submit: "解锁" },
  offline: { title: "本机数据不可用", desc: "无法打开本机加密存储", label: "主口令", submit: "重试" },
};

async function bootstrap() {
  let info;
  try {
    info = await api.authState();
  } catch (err) {
    const msg = err instanceof ApiError ? err.friendly : err?.message || "本机数据不可用";
    return showAuth("offline", msg);
  }
  if (!info.vault_initialized) return showAuth("setup");
  if (info.locked) return showAuth("login");
  return enterApp();
}

function showAuth(mode, message) {
  const copy = AUTH_COPY[mode] || AUTH_COPY.login;
  $("#auth-title").textContent = copy.title;
  $("#auth-desc").textContent = copy.desc;
  $("#auth-pw-label").textContent = copy.label;
  $("#auth-submit").textContent = copy.submit;
  $("#auth-form-mode")?.remove();
  const holder = document.createElement("span");
  holder.id = "auth-form-mode";
  holder.hidden = true;
  holder.dataset.mode = mode;
  $("#auth-mask").appendChild(holder);
  const errBox = $("#auth-error");
  errBox.textContent = message || "";
  errBox.classList.toggle("hidden", !message);
  $("#auth-mask").classList.remove("hidden");
  $("#app").hidden = true;
  $("#auth-password").value = "";
}

async function submitAuth(e) {
  e.preventDefault();
  const mode = $("#auth-form-mode")?.dataset.mode || "login";
  const password = $("#auth-password").value;
  const errBox = $("#auth-error");
  if (!password) {
    errBox.textContent = "请输入主口令";
    errBox.classList.remove("hidden");
    return;
  }
  const btn = $("#auth-submit");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "验证中…";
  // PBKDF2 20 万轮在服务端计算，这里只是等待
  try {
    if (mode === "setup") await api.setup(password);
    else await api.login(password);
    enterApp();
  } catch (err) {
    errBox.textContent = err instanceof ApiError ? err.friendly : err.message;
    errBox.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function enterApp() {
  $("#auth-mask").classList.add("hidden");
  $("#app").hidden = false;
  switchView(current);
}

/* ---------------- 路由 ---------------- */
function switchView(name) {
  current = name;
  $$("[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === name));
  const view = views[name];
  $("#view-title").textContent = view.title;
  $("#view-subtitle").textContent = typeof view.subtitle === "function" ? view.subtitle() : view.subtitle || "";
  $("#fab").classList.toggle("hidden", name === "dashboard");

  const root = $("#view");
  const fresh = !mounted.has(name);
  (async () => {
    try {
      if (fresh) {
        await view.mount(root);
        mounted.add(name);
      } else {
        await view.refresh();
      }
    } catch (err) {
      handleError(err);
    }
  })();
}

async function onFab() {
  const view = views[current];
  try {
    if (view.addSheet) await view.addSheet();
    else if (view.editSheet) await view.editSheet(null);
    else await view.refresh();
  } catch (err) {
    handleError(err);
  }
}

function handleError(err) {
  if (err instanceof ApiError) {
    if (err.code === "unauthorized") return showAuth("login", "会话已过期，请重新进入");
    if (err.code === "vault_locked") return showAuth("unlock", "账库已锁定，请重新解锁");
    return toast(err.friendly, "error");
  }
  toast(err?.message || "未知错误", "error");
}

/* ---------------- 绑定 ---------------- */
$$("[data-view]").forEach((el) => {
  el.addEventListener("click", () => switchView(el.dataset.view));
});
$("#fab").addEventListener("click", onFab);
$("#auth-mask").addEventListener("submit", submitAuth);
$("#auth-form")?.addEventListener("submit", submitAuth);
// index.html 里 auth-mask 是 div，这里退化为按钮点击兜底
$("#auth-submit").addEventListener("click", (e) => {
  e.preventDefault();
  submitAuth(e);
});
$("#auth-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitAuth(e);
});

$("#lock-btn").addEventListener("click", async () => {
  try {
    await api.lock();
    showAuth("unlock", "账库已锁定");
  } catch (err) {
    handleError(err);
  }
});
$("#logout-btn").addEventListener("click", async () => {
  try { await api.logout(); } catch { /* 无论成败都回到登录 */ }
  mounted.clear();
  showAuth("login", "已退出登录");
});

/* ---------------- 数据与备份 ---------------- */

function openDataSheet() {
  const host = $("#sheet-host");
  host.innerHTML = `
    <div class="mask">
      <div class="sheet">
        <div class="grabber"></div>
        <div class="sheet-head">
          <h3>数据与备份</h3>
          <button class="btn ghost sm" data-close>关闭</button>
        </div>
        <div style="padding:0 16px 18px;max-height:70vh;overflow:auto">
          <p class="hintline">
            你的全部数据（账号口令、工资、账单、照片）都是加密后存在这台设备上的，
            不会上传到任何服务器。主口令本身不落盘，忘记就无法解开。
          </p>

          <div class="section-title" style="margin-top:14px">1. 从别的软件搬进来</div>
          <p class="hintline">
            你在别的账号本子、记账 App、影视清单里记的东西，可以直接导入过来。
            解析和导入都只在这台设备上做，而且会先让你看清楚会变成什么样再写入。
          </p>
          <button class="btn ghost" id="bk-import">导入数据</button>

          <div class="section-title" style="margin-top:18px">2. 多设备同步与分享</div>
          <p class="hintline">
            云同步上传的是<strong>密文</strong>；分享给别人时用单独的一次性口令，
            <strong>永远不要把主口令给别人</strong>。
          </p>
          <div style="display:flex;gap:10px">
            <button class="btn ghost" id="bk-sync">云同步设置</button>
            <button class="btn ghost" id="bk-share">分享给别人</button>
          </div>

          <div class="section-title" style="margin-top:18px">3. 导出备份</div>
          <p class="hintline">手机丢了或换机时用它恢复。备份串已加密，可以放心存到备忘录或发给自己。</p>
          <label class="field"><span>备份口令（至少 6 位，请自己记住）</span>
            <input type="password" id="bk-pw" placeholder="用于加密这份备份" />
          </label>
          <button class="btn block" id="bk-export">生成加密备份</button>
          <textarea id="bk-out" rows="5" readonly
            placeholder="生成后备份内容会出现在这里，长按全选 → 复制"></textarea>

          <div class="section-title" style="margin-top:18px">4. 恢复备份</div>
          <label class="field"><span>把之前导出的备份内容粘贴到这里</span>
            <textarea id="bk-in" rows="4" placeholder="粘贴备份内容"></textarea>
          </label>
          <button class="btn block" id="bk-import">用备份覆盖本机数据</button>
          <p class="hintline">恢复会覆盖当前数据且不可撤销，建议先导出一份当前的。</p>

          <div class="section-title" style="margin-top:18px">5. 存储占用</div>
          <p class="hintline" id="bk-usage">正在统计…</p>
        </div>
      </div>
    </div>`;

  const close = () => { host.innerHTML = ""; };
  $("[data-close]", host).addEventListener("click", close);
  $(".mask", host).addEventListener("click", (e) => {
    if (e.target.classList.contains("mask")) close();
  });

  // 从「数据」面板跳到另一个面板：先关掉自己，避免两层遮罩叠在一起
  const hop = (open) => {
    close();
    try {
      open();
    } catch (err) {
      handleError(err);
    }
  };
  $("#bk-sync", host).addEventListener("click", () => hop(openSyncSheet));
  $("#bk-share", host).addEventListener("click", () => hop(openShareSheet));
  $("#bk-import", host).addEventListener("click", () => hop(openImportSheet));

  api.localUsage()
    .then((u) => {
      const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
      $("#bk-usage", host).textContent = `本机已用 ${mb(u.usage)}${u.quota ? `，可用上限约 ${mb(u.quota)}` : ""}`;
    })
    .catch(() => { $("#bk-usage", host).textContent = "无法读取存储占用"; });

  $("#bk-export", host).addEventListener("click", async () => {
    const out = $("#bk-out", host);
    try {
      const res = await api.localExport($("#bk-pw", host).value);
      out.value = res.payload;
      out.focus();
      out.setSelectionRange(0, out.value.length);
      toast("已生成加密备份，长按可全选复制", "ok");
    } catch (err) {
      handleError(err);
    }
  });

  $("#bk-import", host).addEventListener("click", async () => {
    const text = $("#bk-in", host).value;
    if (!text.trim()) return toast("请先粘贴备份内容", "error");
    const yes = await confirmDialog("恢复备份", "这会用备份覆盖本机现有数据，且无法撤销。确定继续？", "覆盖");
    if (!yes) return;
    try {
      await api.localImport($("#bk-pw", host).value, text);
      toast("恢复完成，正在重新加载…", "ok");
      mounted.clear();
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      handleError(err);
    }
    return undefined;
  });
}

$("#data-btn").addEventListener("click", openDataSheet);
$("#sync-btn").addEventListener("click", () => {
  // 面板内部自己会处理错误并显示，这里只兜住「整个面板都打不开」的情况
  try {
    openSyncSheet();
  } catch (err) {
    toast(err?.message || "无法打开同步设置", "error");
  }
});
$("#import-btn").addEventListener("click", () => {
  try {
    openImportSheet();
  } catch (err) {
    toast(err?.message || "无法打开导入面板", "error");
  }
});

// 导入会一次性写入一批记录，当前视图里的统计和列表都过期了，让它重新拉一次。
// 只 refresh 不重新 mount，避免刚导入完页面整块闪一下。
window.addEventListener("data:changed", () => {
  const view = views[current];
  if (view && mounted.has(current) && typeof view.refresh === "function") {
    Promise.resolve(view.refresh()).catch(handleError);
  }
});

window.addEventListener("api-error", (e) => handleError(e.detail));
window.addEventListener("unhandledrejection", (e) => handleError(e.reason));

document.getElementById("view-subtitle").textContent = today();
bootstrap();
