// 导入中转界面。
//
// 这一屏的核心任务是**让用户敢按那个按钮**：换软件最怕的不是麻烦，
// 是「我导进来会不会变成一团乱」。所以流程刻意做成「先识别、再预览、后确认」，
// 并且把「认出来这是什么」「会导进哪个模块」「有多少条已存在」全部摊开给用户看。
//
// 实现上沿用同步面板的两条经验：
// 1. 操作期间会重绘，所以每次动作先把表单值抓进 state.form，重绘时回填 ——
//    否则用户刚粘的一大段内容会在点「识别」的瞬间被清空。
// 2. 认错模块比认不出更糟，所以模块下拉框一直可用，用户能随时改判。

import { api } from "./api.js";
import { $, esc, toast } from "./ui.js";
import { decodeBytes } from "./importers.js";

const MODULE_OPTIONS = [
  { key: "account", label: "账号本子" },
  { key: "ledger", label: "记账" },
  { key: "hours", label: "工时记录" },
  { key: "media", label: "影视观影" },
];

/** 分享包是密文，得先有口令才能识别。 */
function looksLikeShare(text) {
  const s = String(text || "").trim();
  if (!s.startsWith("{")) return false;
  try {
    return JSON.parse(s).format === "lifebook-share";
  } catch {
    return false;
  }
}

export function openImportSheet() {
  const host = $("#sheet-host");
  const blank = { text: "", module: "", password: "", includeDuplicates: false, tagImport: true };
  const state = {
    form: { ...blank },
    scan: null,
    sources: null,
    busy: false,
    message: "",
    error: "",
    done: null,
    showSources: false,
    filename: "",
    encoding: "",
  };

  let timer = null;
  const close = () => {
    if (timer) clearTimeout(timer);
    host.innerHTML = "";
  };

  /** 从当前 DOM 抓一次表单值；某字段不在页面上时保留原值。 */
  function readDom() {
    const prev = state.form;
    const val = (sel, key) => {
      const el = $(sel, host);
      return el ? el.value : prev[key] || "";
    };
    const chk = (sel, key) => {
      const el = $(sel, host);
      return el ? !!el.checked : !!prev[key];
    };
    return {
      text: val("#im-text", "text"),
      module: val("#im-module", "module"),
      password: val("#im-pass", "password"),
      includeDuplicates: chk("#im-dup", "includeDuplicates"),
      tagImport: chk("#im-tag", "tagImport"),
    };
  }

  function syncForm() {
    state.form = readDom();
  }

  function scheduleScan() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      runScan();
    }, 400);
  }

  async function runScan() {
    syncForm();
    const { text, module, password } = state.form;
    state.error = "";
    state.done = null;

    if (!text.trim()) {
      state.scan = null;
      state.message = "";
      paint();
      return;
    }
    if (looksLikeShare(text) && !password) {
      state.scan = null;
      state.message = "这是一份分享包，填上对方给的口令就能看到里面有什么。";
      paint();
      return;
    }

    state.busy = true;
    state.message = "正在识别…";
    paint();
    try {
      state.scan = await api.importScan({ text, module, password });
      state.message = "";
    } catch (err) {
      state.scan = null;
      state.message = "";
      state.error = err?.friendly || err?.message || "识别失败";
    } finally {
      state.busy = false;
      paint();
      if (state.error) toast(state.error, "error");
    }
  }

  async function runImport() {
    syncForm();
    const { text, module, password, includeDuplicates, tagImport } = state.form;
    state.busy = true;
    state.error = "";
    paint();
    try {
      const res = await api.importApply({
        text,
        module,
        password,
        include_duplicates: includeDuplicates,
        tag_import: tagImport,
      });
      state.done = res;
      state.message = "";
      // 导入完成后各视图的缓存已经过期，交回主界面时让它整体刷新
      window.dispatchEvent(new CustomEvent("data:changed"));
    } catch (err) {
      state.error = err?.friendly || err?.message || "导入失败";
      toast(state.error, "error");
    } finally {
      state.busy = false;
      paint();
    }
  }

  /** 重新开始：清空输入，保留「打标签」这类偏好。 */
  function reset() {
    state.form = { ...blank, tagImport: state.form.tagImport };
    state.scan = null;
    state.done = null;
    state.error = "";
    state.message = "";
    state.filename = "";
    state.encoding = "";
    paint();
  }

  async function pickFile(file) {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { text, encoding } = decodeBytes(bytes);
      state.form.text = text;
      state.form.module = "";
      state.filename = file.name;
      state.encoding = encoding;
      state.scan = null;
      state.done = null;
      paint();
      await runScan();
    } catch (err) {
      toast(err?.message || "读取文件失败", "error");
    }
  }

  /* ---------------- 渲染 ---------------- */

  function renderScan(scan) {
    if (!scan) return "";
    const st = scan.stats || {};
    const conf = Math.round((scan.confidence || 0) * 100);
    const sourceLine = scan.source
      ? `<span class="tagchip">${esc(scan.source.label)}</span>${scan.source.hint ? ` <span class="hintline" style="display:inline">${esc(scan.source.hint)}</span>` : ""}`
      : `<span class="hintline" style="display:inline">没能确定来源，按字段特征判断</span>`;

    const options = MODULE_OPTIONS.map(
      (m) => `<option value="${m.key}"${scan.module === m.key ? " selected" : ""}>${esc(m.label)}</option>`
    ).join("");

    const alts = (scan.alternatives || []).length
      ? `<p class="hintline">也可能是：${scan.alternatives.map((a) => esc(a.label)).join("、")}（不对就上面改一下）</p>`
      : "";

    const warnings = (scan.warnings || []).length
      ? `<ul class="warnlist">${scan.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`
      : "";

    const preview = (scan.preview || []).length
      ? `<div class="preview-list">${scan.preview.map((line) => `<div class="preview-row">${esc(line)}</div>`).join("")}</div>`
      : "";

    const dupNote = st.duplicate
      ? `<p class="hintline">其中 <strong>${st.duplicate}</strong> 条看起来已经有了，默认跳过。</p>`
      : "";

    return `
      <div class="card" style="margin-top:14px">
        <div class="section-title" style="margin-top:0">识别结果</div>
        <p>${sourceLine}</p>
        <p class="hintline">共认出 <strong>${st.parsed || 0}</strong> 条，将新增
          <strong>${st.fresh || 0}</strong> 条${st.skipped ? `，${st.skipped} 行信息不足已跳过` : ""}。</p>
        <label class="field" style="margin-top:10px"><span>导入到（判错了可以改）</span>
          <select id="im-module">${options}</select>
        </label>
        ${alts}
        ${dupNote}
        ${warnings}
        ${preview}
      </div>`;
  }

  function renderDone(done) {
    const created = Object.entries(done.created || {}).filter(([, n]) => n > 0);
    const labels = { account: "账号", transaction: "账单", session: "工时", journal: "日记", media: "影视" };
    const lines = created.map(([k, n]) => `${labels[k] || k} ${n} 条`).join("，");
    const failed = (done.failed || []).length;

    return `
      <div class="card" style="margin-top:14px">
        <div class="section-title" style="margin-top:0">导入完成</div>
        ${
          done.nothing_new
            ? `<p>这些内容之前都已经导入过了，没有新增。如果你确实要再存一份，勾上「重复的也导入」再试一次。</p>`
            : `<p>已成功导入 <strong>${done.created_total}</strong> 条：${esc(lines)}。</p>`
        }
        ${done.skipped_duplicate ? `<p class="hintline">跳过了 ${done.skipped_duplicate} 条重复内容。</p>` : ""}
        ${
          failed
            ? `<div class="section-title">有 ${failed} 条没能导入</div>
               <ul class="warnlist">${done.failed.slice(0, 5).map((f) => `<li>${esc(f.label)}：${esc(f.message)}</li>`).join("")}</ul>`
            : ""
        }
        <p class="hintline">这些记录都带了「导入」标签，以后想找回来或删掉一批，在对应模块里搜「导入」即可。</p>
      </div>`;
  }

  function renderSources() {
    const list = state.sources?.sources || [];
    if (!state.showSources) {
      return `<button class="btn ghost sm" id="im-toggle" type="button">看看支持导入哪些软件</button>`;
    }
    const rows = list
      .map((s) => `<li><strong>${esc(s.label)}</strong><br /><span class="hintline">${esc(s.what)}</span></li>`)
      .join("");
    return `
      <div class="card">
        <div class="section-title" style="margin-top:0">支持导入的来源</div>
        <ul class="srclist">${rows}</ul>
        <p class="hintline">列表之外也能试：只要导出内容里有「账号/密码」这种成对的字段，
          或者是带表头的表格，基本都能认出来。认不出来也不会导入任何东西。</p>
        <button class="btn ghost sm" id="im-toggle" type="button">收起</button>
      </div>`;
  }

  function paint() {
    const form = state.form;
    const dis = state.busy ? "disabled" : "";
    const isShare = looksLikeShare(form.text);
    const scan = state.scan;

    const canImport = !!scan && !state.busy && (scan.stats?.fresh > 0 || form.includeDuplicates);

    host.innerHTML = `
      <div class="mask">
        <div class="sheet">
          <div class="grabber"></div>
          <div class="sheet-head">
            <h3>导入数据</h3>
            <button class="btn ghost sm" data-close>关闭</button>
          </div>
          <div style="padding:0 16px 18px;max-height:76vh;overflow:auto">
            <p class="hintline">
              把你在别处记的东西搬过来。识别和导入都只在这台设备上完成，
              内容不会上传到任何地方；导入前你可以先看一遍会变成什么样。
            </p>

            <div class="section-title" style="margin-top:12px">1. 内容</div>
            <textarea id="im-text" rows="6" ${dis}
              placeholder="把导出的内容粘到这里，或者用下面的按钮选文件">${esc(form.text)}</textarea>
            <div style="display:flex;gap:10px;align-items:center;margin-top:8px">
              <label class="btn ghost sm" style="cursor:pointer">
                选择文件
                <input type="file" id="im-file" accept=".csv,.tsv,.txt,.json,.tab" style="display:none" />
              </label>
              <button class="btn ghost sm" id="im-clear" type="button" ${dis}>清空</button>
              <span class="hintline" style="margin:0">${form.text ? `${esc(state.filename || "已粘贴内容")}${state.encoding ? `（${esc(state.encoding)}）` : ""}` : "支持 CSV / TSV / JSON / 纯文本"}</span>
            </div>

            ${
              isShare
                ? `<label class="field" style="margin-top:10px"><span>这份分享包的口令（向分享的人要）</span>
                     <input type="password" id="im-pass" value="${esc(form.password)}" placeholder="分享口令" ${dis} /></label>`
                : ""
            }

            ${state.message ? `<p class="hintline" style="margin-top:10px">${esc(state.message)}</p>` : ""}
            ${state.error ? `<p class="errline">${esc(state.error)}</p>` : ""}

            ${state.done ? renderDone(state.done) : renderScan(scan)}

            ${
              !state.done && scan
                ? `<div class="section-title" style="margin-top:14px">2. 选项</div>
                   <label class="checkline"><input type="checkbox" id="im-dup" ${form.includeDuplicates ? "checked" : ""} ${dis} />
                     <span>重复的也导入（默认跳过已有的）</span></label>
                   <label class="checkline"><input type="checkbox" id="im-tag" ${form.tagImport ? "checked" : ""} ${dis} />
                     <span>给导入的记录打上「导入」标签，方便以后找回或删除</span></label>
                   <p class="hintline">账号有唯一性限制（同一平台同一账号只能一条），所以重复的账号即使勾上也进不来。</p>`
                : ""
            }

            <div style="display:flex;gap:10px;margin-top:16px">
              ${
                state.done
                  ? `<button class="btn ghost" id="im-again" type="button">再导入一份</button>
                     <button class="btn block" data-close>完成</button>`
                  : `<button class="btn block" id="im-go" type="button" ${canImport ? "" : "disabled"}>
                       ${state.busy ? "导入中…" : `开始导入${scan && scan.stats?.fresh ? ` ${scan.stats.fresh} 条` : ""}`}
                     </button>`
              }
            </div>

            <div style="margin-top:18px">${renderSources()}</div>
          </div>
        </div>
      </div>`;

    // 绑定
    $("[data-close]", host).addEventListener("click", close);
    $(".mask", host).addEventListener("click", (e) => {
      if (e.target.classList.contains("mask")) close();
    });

    const textarea = $("#im-text", host);
    textarea.addEventListener("input", () => {
      state.form.text = textarea.value;
      state.filename = "";
      state.encoding = "";
      scheduleScan();
    });

    $("#im-file", host)?.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      // 选完立刻把 input 清空，否则同一个文件连选两次不会再触发 change
      e.target.value = "";
      pickFile(file);
    });

    $("#im-clear", host)?.addEventListener("click", reset);
    $("#im-go", host)?.addEventListener("click", runImport);
    $("#im-again", host)?.addEventListener("click", reset);

    $("#im-module", host)?.addEventListener("change", (e) => {
      // 改了模块要重解析：字段映射是跟着模块走的
      state.form.module = e.target.value;
      runScan();
    });
    $("#im-pass", host)?.addEventListener("input", (e) => {
      state.form.password = e.target.value;
      scheduleScan();
    });
    $("#im-dup", host)?.addEventListener("change", (e) => {
      state.form.includeDuplicates = e.target.checked;
      paint();
    });
    $("#im-tag", host)?.addEventListener("change", (e) => {
      state.form.tagImport = e.target.checked;
    });
    $("#im-toggle", host)?.addEventListener("click", () => {
      syncForm();
      state.showSources = !state.showSources;
      paint();
    });
  }

  paint();

  // 来源清单不是关键路径，放到后台拿；失败就不显示这一块
  api.importSources()
    .then((res) => {
      state.sources = res;
      if (state.showSources) paint();
    })
    .catch(() => {});
}
