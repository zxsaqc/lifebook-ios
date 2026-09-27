// 同步与分享界面。
//
// 两件事刻意让用户看明白：
// 1. 同步上传的是**密文**。网盘方看不到内容，也看不到你有几个账号、花了多少钱。
// 2. 分享给别人时**不要给主口令**。主口令能解开全部数据，分享包用的是另一把钥匙。
//
// 实现上有个要点：所有操作都可能比较慢（要联网），期间界面会重绘成「处理中」。
// 所以每次动作都先把表单值抓进 state.form，重绘时再从 state.form 回填——
// 否则用户刚填的地址会在操作开始时被清空。

import { api } from "./api.js";
import { $, esc, toast } from "./ui.js";

const KIND_LABELS = {
  account: "账号",
  transaction: "账单",
  session: "工时",
  journal: "日记",
  media: "影视",
};

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function sheetShell(title, inner) {
  return `
    <div class="mask">
      <div class="sheet">
        <div class="grabber"></div>
        <div class="sheet-head">
          <h3>${esc(title)}</h3>
          <button class="btn ghost sm" data-close>关闭</button>
        </div>
        <div style="padding:0 16px 18px;max-height:74vh;overflow:auto">${inner}</div>
      </div>
    </div>`;
}

function bindSheet(host, close) {
  $("[data-close]", host).addEventListener("click", close);
  $(".mask", host).addEventListener("click", (e) => {
    if (e.target.classList.contains("mask")) close();
  });
}

/* ==================== 云同步 ==================== */

export function openSyncSheet() {
  const host = $("#sheet-host");
  const blank = {
    baseUrl: "",
    username: "",
    password: "",
    includeAttachments: false,
    masterPassword: "",
    deviceName: "",
  };
  const state = { status: null, probe: null, message: "", error: "", busy: false, dirty: false, form: blank };

  const close = () => {
    host.innerHTML = "";
  };

  /** 从当前 DOM 抓一次表单值；某个字段不在页面上时保留原值。 */
  function readDom() {
    const prev = state.form || blank;
    const val = (sel, key) => {
      const el = $(sel, host);
      return el ? el.value : prev[key] || "";
    };
    const chk = (sel, key) => {
      const el = $(sel, host);
      return el ? !!el.checked : !!prev[key];
    };
    return {
      baseUrl: val("#sy-url", "baseUrl"),
      username: val("#sy-user", "username"),
      password: val("#sy-pass", "password"),
      includeAttachments: chk("#sy-media", "includeAttachments"),
      masterPassword: val("#sy-master", "masterPassword"),
      deviceName: val("#sy-device", "deviceName"),
    };
  }

  function paint() {
    const st = state.status || {};
    const form = state.form || blank;
    const probe = state.probe;
    const dis = state.busy ? "disabled" : "";
    const configured = !!st.configured;

    const statusLine = st.last_sync_at
      ? `上次同步：${formatTime(st.last_sync_at)}${st.last_result ? `（${st.last_result}）` : ""}`
      : "还没有同步过";

    let actionBlock = "";
    if (probe) {
      if (probe.action === "publish") {
        actionBlock = `
          <div class="card" style="margin-top:12px">
            <div class="section-title" style="margin-top:0">云端目录还是空的</div>
            <p class="hintline">这个目录里还没有 LifeBook 账库。点下面的按钮会把本机账库
              （密文）首次上传，之后其它设备就能「加入」它。</p>
            <button class="btn block" id="sy-publish" ${dis}>首次上传到云端</button>
          </div>`;
      } else if (probe.action === "sync") {
        actionBlock = `
          <div class="card" style="margin-top:12px">
            <div class="section-title" style="margin-top:0">云端就是本机这个账库</div>
            <p class="hintline">可以直接同步。同一条记录两边都改过时，以改动时间较晚的为准。</p>
            <button class="btn block" id="sy-run" ${dis}>立即同步</button>
          </div>`;
      } else {
        actionBlock = `
          <div class="card" style="margin-top:12px">
            <div class="section-title" style="margin-top:0">云端已有另一个账库</div>
            <p class="hintline">
              这个目录里已经有一个账库了（创建于
              ${esc(String(probe.created_at || "").slice(0, 10) || "未知时间")}）。
              加入它会把本机数据合并进去，并**改用云端账库的密钥**，
              所以需要再输入一次主口令来重新加密本机数据。
            </p>
            <p class="hintline" style="color:#c0392b">
              两台设备必须用同一个主口令，否则无法共用同一份数据。
            </p>
            <label class="field"><span>再次输入主口令</span>
              <input type="password" id="sy-master" placeholder="本机主口令"
                     value="${esc(form.masterPassword)}" />
            </label>
            <button class="btn block" id="sy-adopt" ${dis}>加入云端账库并合并</button>
          </div>`;
      }
    }

    host.innerHTML = sheetShell("云同步", `
      <p class="hintline">
        同步走你自己选的一个存储位置（WebDAV：坚果云 / Nextcloud / 群晖等），
        <strong>上传的全部是密文</strong>——对方既看不到你的内容，也看不到你有几个账号、
        花了多少钱。主口令和那把钥匙都不会离开这台设备。
      </p>

      <div class="section-title">服务器</div>
      <label class="field"><span>WebDAV 地址</span>
        <input id="sy-url" autocapitalize="off" autocorrect="off" spellcheck="false"
               placeholder="例如 https://dav.jianguoyun.com/dav/lifebook"
               value="${esc(form.baseUrl)}" />
      </label>
      <label class="field"><span>账号</span>
        <input id="sy-user" autocapitalize="off" autocorrect="off" spellcheck="false"
               placeholder="登录名" value="${esc(form.username)}" />
      </label>
      <label class="field"><span>应用密码</span>
        <input type="password" id="sy-pass"
               placeholder="${configured ? "已保存，留空则沿用" : "只填一次，之后加密保存在本机"}" />
      </label>
      <label style="display:flex;align-items:center;gap:10px;margin:10px 0 4px">
        <input type="checkbox" id="sy-media" ${form.includeAttachments ? "checked" : ""} />
        <span class="hintline" style="margin:0">连照片附件一起同步（体积大、上传也慢，默认关）</span>
      </label>
      <button class="btn block" id="sy-test" ${dis}>保存并检查云端</button>

      ${actionBlock}

      ${state.error ? `<p class="errline" style="margin-top:12px">${esc(state.error)}</p>` : ""}
      ${state.message ? `<p class="hintline" style="margin-top:12px">${esc(state.message)}</p>` : ""}

      <div class="section-title">本机设备</div>
      <p class="hintline">${esc(statusLine)}</p>
      <label class="field"><span>设备名（多台设备时用来分辨）</span>
        <input id="sy-device" maxlength="24" value="${esc(form.deviceName)}" />
      </label>
      <div style="display:flex;gap:10px">
        <button class="btn ghost" id="sy-rename" ${dis}>改名</button>
        <button class="btn ghost" id="sy-off" ${dis}>断开同步</button>
      </div>
      <p class="hintline">断开只会清掉本机的服务器配置，云端那份仓库不动，其它设备照常使用。</p>
    `);

    bindSheet(host, close);
    const bind = (sel, fn) => {
      const el = $(sel, host);
      if (el) el.addEventListener("click", fn);
    };
    bind("#sy-test", () => guard(actTest));
    bind("#sy-publish", () => guard(actPublish));
    bind("#sy-run", () => guard(actRun));
    bind("#sy-adopt", () => guard(actAdopt));
    bind("#sy-rename", () => guard(actRename));
    bind("#sy-off", () => guard(actOff));
  }

  /** 先把用户输入抓进 state.form，再进入「处理中」并重绘。 */
  async function guard(fn) {
    state.dirty = true;
    state.form = readDom();
    state.error = "";
    state.message = "";
    state.busy = true;
    paint();
    try {
      await fn(state.form);
    } catch (err) {
      state.error = err?.friendly || err?.message || "操作失败";
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function refreshStatus() {
    state.status = await api.syncStatus();
  }

  async function actTest(form) {
    state.status = await api.syncConfigure({
      baseUrl: form.baseUrl,
      username: form.username,
      password: form.password,
      includeAttachments: form.includeAttachments,
    });
    // 密码已经加密存好，输入框清空并改为「留空沿用」
    state.form.password = "";
    state.probe = await api.syncInspect();
    if (!state.probe.has_repo) {
      state.message = "连接正常，云端目录还是空的，可以首次上传。";
    } else if (state.probe.action === "sync") {
      state.message = "连接正常，云端就是本机这个账库。";
    } else {
      state.message = "连接正常，但云端已存在另一个账库，需要「加入」它。";
    }
    toast("连接正常", "ok");
  }

  async function actPublish(form) {
    const res = await api.syncPublish({ includeAttachments: form.includeAttachments });
    await refreshStatus();
    state.probe = await api.syncInspect();
    state.message = `首次上传完成，云端现有 ${res.pushed} 条记录（全部为密文）。`;
    toast("已上传到云端", "ok");
  }

  async function actRun() {
    const res = await api.syncRun();
    await refreshStatus();
    state.message =
      `同步完成：拉取 ${res.pulled} 条，上传 ${res.pushed} 条` +
      `${res.unchanged ? "（云端无需更新）" : ""}。`;
    toast("同步完成", "ok");
  }

  async function actAdopt(form) {
    if (!form.masterPassword) throw new Error("请输入主口令");
    const res = await api.syncAdopt({ masterPassword: form.masterPassword });
    state.form.masterPassword = "";
    await refreshStatus();
    state.probe = await api.syncInspect();
    state.message = res.rekeyed
      ? `已加入云端账库：本机 ${res.rows} 条记录已用新密钥重新加密，并拉取 ${res.pulled} 条。`
      : `已加入云端账库，拉取 ${res.pulled} 条。`;
    toast("已加入云端账库", "ok");
  }

  async function actRename(form) {
    if (!form.deviceName) throw new Error("设备名不能为空");
    await api.syncRenameDevice(form.deviceName);
    await refreshStatus();
    state.message = "设备名已更新。";
  }

  async function actOff() {
    state.status = await api.syncDisconnect();
    state.probe = null;
    state.form = { ...blank, deviceName: state.form.deviceName };
    state.message = "已断开同步，本机配置已清除。";
    toast("已断开同步", "ok");
  }

  paint();
  api
    .syncStatus()
    .then((st) => {
      state.status = st;
      if (!state.dirty) {
        state.form = {
          baseUrl: st.base_url || "",
          username: st.username || "",
          password: "",
          includeAttachments: !!st.include_attachments,
          masterPassword: "",
          deviceName: st.device_name || "",
        };
      }
      paint();
    })
    .catch((err) => {
      state.error = err?.friendly || err?.message || "无法读取同步状态";
      paint();
    });
}

/* ==================== 加密分享 ==================== */

function monthOptions() {
  const out = [];
  const d = new Date();
  for (let i = 0; i < 12; i += 1) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

export function openShareSheet() {
  const host = $("#sheet-host");
  const months = monthOptions();
  const close = () => {
    host.innerHTML = "";
  };

  host.innerHTML = sheetShell("加密分享", `
    <p class="hintline">
      <strong>不要把主口令告诉别人</strong>——它能解开你的全部数据。
      分享用的是单独约定的一次性口令：对方拿到分享串 + 这个口令就能查看，
      但看不到你其它任何东西。分享的账号清单会自动去掉口令和两步验证密钥。
    </p>

    <div class="section-title">1. 生成一份分享</div>
    <div class="card">
      <div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:6px">
        ${["transaction", "media", "session", "journal", "account"]
          .map(
            (k, i) => `
          <label style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" class="sh-kind" value="${k}" ${i === 0 ? "checked" : ""} />
            <span>${KIND_LABELS[k]}</span>
          </label>`
          )
          .join("")}
      </div>
      <label class="field"><span>限定月份（可选）</span>
        <select id="sh-month">
          <option value="">不限</option>
          ${months.map((m) => `<option value="${m}">${m}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>给对方的一句话（同样会被加密）</span>
        <input id="sh-note" placeholder="例如：这是 9 月的开销明细" />
      </label>
      <label class="field"><span>分享口令（至少 6 位，另行告诉对方）</span>
        <input type="password" id="sh-pw" placeholder="不要用主口令" />
      </label>
      <label class="field"><span>有效期</span>
        <select id="sh-ttl">
          <option value="1">1 天</option>
          <option value="7" selected>7 天</option>
          <option value="30">30 天</option>
          <option value="0">不过期</option>
        </select>
      </label>
      <p class="hintline" id="sh-preview">勾选内容后可以看到条数</p>
      <div style="display:flex;gap:10px">
        <button class="btn ghost" id="sh-count">预览条数</button>
        <button class="btn block" id="sh-make">生成分享串</button>
      </div>
      <textarea id="sh-out" rows="5" readonly
        placeholder="生成后出现在这里，长按全选复制"></textarea>
      <button class="btn ghost sm" id="sh-copy">复制</button>
    </div>

    <div class="section-title">2. 打开别人给的分享</div>
    <label class="field"><span>粘贴分享内容</span>
      <textarea id="sh-in" rows="4" placeholder="粘贴对方发来的分享串"></textarea>
    </label>
    <label class="field"><span>分享口令</span>
      <input type="password" id="sh-in-pw" placeholder="对方另行告诉你的口令" />
    </label>
    <button class="btn block" id="sh-open">打开查看</button>
    <p class="hintline hidden" id="sh-head"></p>
    <div id="sh-result"></div>
  `);
  bindSheet(host, close);

  const all = (sel) => Array.from(host.querySelectorAll(sel));
  const pickedKinds = () => all(".sh-kind").filter((el) => el.checked).map((el) => el.value);

  async function run(fn, quiet = false) {
    try {
      await fn();
    } catch (err) {
      const msg = err?.friendly || err?.message || "操作失败";
      if (quiet) $("#sh-preview", host).textContent = msg;
      else toast(msg, "error");
    }
  }

  async function countPreview() {
    const res = await api.sharePreview({ kinds: pickedKinds(), month: $("#sh-month", host).value });
    const parts = Object.entries(res.counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${KIND_LABELS[k]} ${n} 条`);
    $("#sh-preview", host).textContent = res.total
      ? `将分享：${parts.join("、")}，共 ${res.total} 条`
      : "所选范围内没有记录";
  }

  async function makeShare() {
    const pw = $("#sh-pw", host).value;
    if (pw.length < 6) {
      $("#sh-preview", host).textContent = "分享口令至少 6 位";
      return;
    }
    const res = await api.shareCreate({
      kinds: pickedKinds(),
      month: $("#sh-month", host).value,
      note: $("#sh-note", host).value,
      password: pw,
      ttlDays: Number($("#sh-ttl", host).value),
    });
    const out = $("#sh-out", host);
    out.value = res.payload;
    out.focus();
    out.setSelectionRange(0, out.value.length);
    $("#sh-preview", host).textContent = `已生成，共 ${res.total} 条。分享串和口令请分开告诉对方。`;
    toast("已生成分享串", "ok");
  }

  async function openShare() {
    const text = $("#sh-in", host).value;
    const pw = $("#sh-in-pw", host).value;
    if (!text.trim()) {
      toast("请先粘贴分享内容", "error");
      return;
    }
    const peek = await api.sharePeek(text);
    const head = $("#sh-head", host);
    head.classList.remove("hidden");
    head.textContent = peek.expires_at
      ? `有效期至 ${formatTime(peek.expires_at)}${peek.expired ? "（已过期）" : ""}`
      : "这份分享没有设置有效期";

    const res = await api.shareOpen(pw, text);
    $("#sh-result", host).innerHTML = renderShare(res);
  }

  function renderShare(res) {
    const parts = [];
    if (res.note) parts.push(`<p class="hintline"><strong>${esc(res.note)}</strong></p>`);
    parts.push(
      `<p class="hintline">来自 ${esc(res.from_device || "对方")}，生成于 ${esc(formatTime(res.created_at))}</p>`
    );
    for (const [kind, rows] of Object.entries(res.data || {})) {
      if (!rows.length) continue;
      parts.push(`<div class="section-title">${KIND_LABELS[kind] || kind}（${rows.length} 条）</div>`);
      parts.push('<div class="card" style="font-size:13px;line-height:1.8">');
      for (const r of rows.slice(0, 60)) parts.push(`<div>${esc(describeRow(kind, r))}</div>`);
      if (rows.length > 60) parts.push(`<div class="hintline">…还有 ${rows.length - 60} 条</div>`);
      parts.push("</div>");
    }
    return parts.join("");
  }

  function describeRow(kind, r) {
    if (kind === "transaction") {
      const y = (Number(r.amount_minor || 0) / 100).toFixed(2);
      return `${r.paid_at || ""}　${r.merchant || ""}　${r.direction === "income" ? "+" : "-"}¥${y}`;
    }
    if (kind === "media") {
      return `${r.watched_on || ""}　${r.title || ""}${r.rating ? `　${r.rating} 分` : ""}`;
    }
    if (kind === "session") {
      return `${r.day || ""}　${r.project || ""}　${((r.minutes || 0) / 60).toFixed(1)}h`;
    }
    if (kind === "journal") return `${r.day || ""}　${r.summary || ""}`;
    if (kind === "account") return `${r.platform || ""}　${r.username || ""}（不含口令）`;
    return JSON.stringify(r);
  }

  async function copyOut() {
    const out = $("#sh-out", host);
    if (!out.value) {
      toast("还没有生成内容", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(out.value);
      toast("已复制到剪贴板", "ok");
    } catch {
      out.focus();
      out.setSelectionRange(0, out.value.length);
      toast("已全选，请手动复制", "ok");
    }
  }

  $("#sh-count", host).addEventListener("click", () => run(countPreview));
  $("#sh-make", host).addEventListener("click", () => run(makeShare));
  $("#sh-open", host).addEventListener("click", () => run(openShare));
  $("#sh-copy", host).addEventListener("click", copyOut);
  all(".sh-kind").forEach((el) => el.addEventListener("change", () => run(countPreview, true)));
  run(countPreview, true);
}
