// 工时视图：今天投入多久 + 当日想法
import { api } from "../api.js";
import { $, $$, esc, openSheet, toast, hoursText, today, prettyDate } from "../ui.js";

let day = today();
let projects = [];
const MOODS = [
  { v: 1, e: "😞", label: "很糟" },
  { v: 2, e: "🙁", label: "低落" },
  { v: 3, e: "😐", label: "还行" },
  { v: 4, e: "🙂", label: "不错" },
  { v: 5, e: "🤩", label: "很棒" },
];

export const hours = {
  id: "hours",
  title: "工时",
  subtitle: () => `记录 ${day}`,
  root: null,

  async mount(root) {
    this.root = root;
    root.innerHTML = `
      <label class="card" style="display:flex;gap:10px;align-items:center">
        <span style="font-size:13px;color:var(--text-dim)">日期</span>
        <input type="date" id="hr-day" value="${day}" style="flex:1" />
      </label>
      <div class="hero" id="hr-hero"><div class="hero-label">当天投入</div><div class="hero-value">—</div></div>
      <div class="stats-grid">
        <div class="stat brand" id="hr-week"><div class="label">近 30 天</div><div class="value">—</div></div>
        <div class="stat green" id="hr-streak"><div class="label">连续记录</div><div class="value">—</div><div class="foot">天</div></div>
        <div class="stat orange" id="hr-mood"><div class="label">平均心情</div><div class="value">—</div></div>
        <div class="stat" id="hr-projects"><div class="label">投入最多</div><div class="value" style="font-size:16px">—</div></div>
      </div>
      <div class="card" id="hr-trend"><div class="section-title">最近 14 天</div></div>
      <div class="section-title">当天工时</div>
      <div class="card" id="hr-sessions"><div class="skeleton"></div></div>
      <div class="section-title">当日想法</div>
      <div class="card">
        <div class="chips" id="hr-moods">
          ${MOODS.map((m) => `<button class="chip" data-mood="${m.v}">${m.e} ${m.label}</button>`).join("")}
        </div>
        <label class="field" style="margin-top:12px"><span>今天在想什么</span>
          <textarea id="hr-summary" rows="5" placeholder="随便写点什么，以后回看会很值钱"></textarea></label>
        <label class="field"><span>高光 / 收获（逗号分隔）</span><input id="hr-highlights" placeholder="写完了三个模块, AI 识别跑通" /></label>
        <button class="btn block" id="hr-save-journal">保存今日想法</button>
      </div>
      <div class="section-title">最近想法</div>
      <div class="card" id="hr-journals"></div>`;

    $("#hr-day", root).addEventListener("change", (e) => {
      day = e.target.value || today();
      this.refresh();
    });
    $("#hr-save-journal", root).addEventListener("click", async () => {
      const mood = $$("#hr-moods .chip", root).find((c) => c.classList.contains("active"))?.dataset.mood || 3;
      const btn = $("#hr-save-journal", root);
      const original = btn.textContent;
      btn.disabled = true; btn.textContent = "保存中…";
      try {
        await api.saveJournal({
          day,
          mood: Number(mood),
          summary: $("#hr-summary", root).value,
          highlights: $("#hr-highlights", root).value,
        });
        toast("已保存", "ok");
        await this.refresh();
      } catch (err) {
        toast(err.friendly || err.message, "error");
      } finally {
        btn.disabled = false; btn.textContent = original;
      }
    });
    $$("#hr-moods .chip", root).forEach((chip) => {
      chip.addEventListener("click", () => {
        $$("#hr-moods .chip", root).forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
      });
    });

    await this.refresh();
  },

  async refresh() {
    const root = this.root;
    if (!root) return;
    const [data, stats, journals] = await Promise.all([
      api.dayHours(day),
      api.hoursStats(30),
      api.journals(6),
    ]);

    projects = stats.by_project ? Object.keys(stats.by_project).slice(0, 8) : projects;

    $("#hr-hero", root).innerHTML = `
      <div class="hero-label">${esc(day)} 当天投入</div>
      <div class="hero-value">${hoursText(data.total_minutes)}</div>
      <div class="hero-foot"><span>${data.sessions.length} 段记录</span><span>${data.sessions.length ? `平均心情 ${avgMood(data.sessions)}` : "还没记录"}</span></div>`;

    $("#hr-week .value", root).textContent = stats.total_hours + "h";
    $("#hr-streak .value", root).textContent = stats.streak_days;
    $("#hr-mood .value", root).textContent = MOODS.find((m) => Math.round(stats.avg_mood) === m.v)?.e || "—";
    const topProject = Object.entries(stats.by_project || {})[0];
    $("#hr-projects .value", root).textContent = topProject ? `${topProject[0]} · ${hoursText(topProject[1])}` : "—";

    const recent = stats.recent_days || [];
    const max = Math.max(1, ...recent.map((d) => d.minutes));
    $("#hr-trend", root).innerHTML = `<div class="section-title">最近 14 天</div>` +
      (recent.length
        ? `<div class="trend">${recent.map((d) => `<div class="tb" style="height:${Math.max(4, Math.round(d.minutes / max * 100))}%" title="${d.day} ${hoursText(d.minutes)}"><span>${d.day.slice(8)}</span></div>`).join("")}</div>`
        : `<div class="empty">还没有工时数据</div>`);

    const list = $("#hr-sessions", root);
    list.innerHTML = data.sessions.length
      ? `<div class="rows">${data.sessions.map((s) => `
          <div class="row" data-sid="${s.id}">
            <div class="row-main">
              <div class="row-title">${esc(s.project)} <span class="badge">${hoursText(s.minutes)}</span> ${s.mood_label ? `<span class="badge brand">${s.mood_label}</span>` : ""}</div>
              <div class="row-sub">${esc(s.content || "（没有写备注）")}</div>
            </div>
            <button class="btn sm danger" data-act="del">删除</button>
          </div>`).join("")}</div>`
      : `<div class="empty"><span class="big">⏱</span>今天还没有记录工时<br />点右下角 ＋ 记一段</div>`;

    $$("[data-act=del]", list).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sid = btn.closest("[data-sid]").dataset.sid;
        await api.deleteSession(sid).catch(() => toast("删除失败", "error"));
        toast("已删除", "ok");
        this.refresh();
      });
    });

    if (data.journal) {
      const m = MOODS.find((x) => x.v === data.journal.mood);
      const chip = $(`#hr-moods [data-mood="${data.journal.mood}"]`, root);
      if (chip) {
        $$("#hr-moods .chip", root).forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
      }
      $("#hr-summary", root).value = data.journal.summary;
      $("#hr-highlights", root).value = data.journal.highlights;
      if (m) { /* 心情已高亮 */ }
    }

    $("#hr-journals", root).innerHTML = journals.length
      ? `<div class="rows">${journals.map((j) => `
          <div class="row" data-day="${j.day}">
            <div class="row-main">
              <div class="row-title">${MOODS.find((x) => x.v === j.mood)?.e || ""} ${esc(prettyDate(j.day))}</div>
              <div class="row-sub">${esc(j.summary.slice(0, 80) || j.highlights)}</div>
            </div>
          </div>`).join("")}</div>`
      : `<div class="empty">还没有记过想法</div>`;

    $$("#hr-journals .row", root).forEach((row) => {
      row.addEventListener("click", () => {
        day = row.dataset.day;
        $("#hr-day", root).value = day;
        this.refresh();
      });
    });
  },

  addSheet() {
    openSheet({
      title: "记一段工时",
      bodyHtml: `
        <div class="field-grid">
          <label class="field"><span>日期</span><input name="day" type="date" value="${day}" /></label>
          <label class="field"><span>时长（分钟）*</span><input name="minutes" inputmode="numeric" placeholder="90" /></label>
        </div>
        <div class="chips" style="margin-bottom:10px">
          ${[25, 45, 60, 90, 120, 180].map((m) => `<button class="chip" type="button" data-min="${m}">${m} 分钟</button>`).join("")}
        </div>
        <label class="field"><span>项目</span><input name="project" list="proj-list" placeholder="项目 / 事情" />
          <datalist id="proj-list">${projects.map((p) => `<option value="${esc(p)}"></option>`).join("")}</datalist></label>
        <label class="field"><span>做了什么 / 想法</span><textarea name="content" placeholder="具体产出或收获"></textarea></label>
        <label class="field"><span>状态</span><select name="mood">
          ${MOODS.map((m) => `<option value="${m.v}">${m.e} ${m.label}</option>`).join("")}
        </select></label>
        <p class="errline hidden" data-err></p>`,
      submitText: "记下来",
      onSubmit: async (form) => {
        const fd = new FormData(form);
        const minutes = Number(fd.get("minutes") || 0);
        if (!minutes || minutes <= 0) throw showError(form, "请填写时长");
        if (!String(fd.get("project") || "").trim()) throw showError(form, "请填写项目名");
        try {
          await api.createSession({
            day: fd.get("day"),
            minutes,
            project: String(fd.get("project")).trim(),
            content: fd.get("content"),
            mood: Number(fd.get("mood")),
          });
        } catch (err) {
          throw showError(form, err.friendly || err.message);
        }
        toast("已记录", "ok");
        await this.refresh();
      },
    });
    const sheet = $("#sheet-host");
    $$("[data-min]", sheet).forEach((chip) => {
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        $('input[name="minutes"]', sheet).value = chip.dataset.min;
      });
    });
  },
};

function showError(form, message) {
  const el = $("[data-err]", form);
  if (el) { el.textContent = message; el.classList.remove("hidden"); }
  toast(message, "error");
  return new Error(message);
}

function avgMood(sessions) {
  const v = sessions.reduce((a, s) => a + s.mood, 0) / sessions.length;
  return v.toFixed(1);
}
