// 影视观影视图（apollo 形态）
import { api } from "../api.js";
import { $, $$, esc, openSheet, confirmDialog, toast, starPickerHtml, bindStarPicker, today, emptyIcon } from "../ui.js";

let meta = { kinds: [], statuses: [] };
let status = "";
let kind = "";
let query = { q: "", limit: 60, offset: 0 };

export const media = {
  id: "media",
  title: "影视",
  subtitle: "看过的电影与剧集",
  root: null,

  async mount(root) {
    this.root = root;
    meta = await api.mediaMeta().catch(() => meta);
    root.innerHTML = `
      <div class="stats-grid" id="md-stats"></div>
      <div class="chips" id="md-status">
        <button class="chip active" data-st="">全部</button>
        ${meta.statuses.map((s) => `<button class="chip" data-st="${s.key}">${esc(s.label)}</button>`).join("")}
      </div>
      <div class="chips" id="md-kind">
        <button class="chip active" data-k="">全部类型</button>
        ${meta.kinds.map((k) => `<button class="chip" data-k="${k.key}">${esc(k.label)}</button>`).join("")}
      </div>
      <div class="card" id="md-list"><div class="skeleton"></div></div>`;

    const bindChips = (sel, attr, setter) => {
      $$(`${sel} .chip`, root).forEach((chip) => {
        chip.addEventListener("click", () => {
          $$(`${sel} .chip`, root).forEach((c) => c.classList.remove("active"));
          chip.classList.add("active");
          setter(chip.dataset[attr] || "");
          query.offset = 0;
          this.refresh();
        });
      });
    };
    bindChips("#md-status", "st", (v) => (status = v));
    bindChips("#md-kind", "k", (v) => (kind = v));

    await this.refresh();
  },

  async refresh() {
    const root = this.root;
    if (!root) return;
    const [page, stats] = await Promise.all([
      api.listMedia({ ...query, status, kind, limit: 60 }),
      api.mediaStats().catch(() => null),
    ]);

    if (stats) {
      $("#md-stats", root).innerHTML = `
        <div class="stat"><div class="label">总条目</div><div class="value">${stats.total}</div></div>
        <div class="stat green"><div class="label">看完了</div><div class="value">${stats.by_status?.done || 0}</div></div>
        <div class="stat brand"><div class="label">在看</div><div class="value">${stats.by_status?.watching || 0}</div></div>
        <div class="stat orange"><div class="label">今年看完</div><div class="value">${stats.watched_this_year}</div><div class="foot">平均评分 ${stats.avg_rating || "—"}</div></div>`;
    }

    const list = $("#md-list", root);
    list.innerHTML = page.items.length
      ? `<div class="rows">${page.items.map(rowHtml).join("")}</div>`
      : `<div class="empty">${emptyIcon("film", 34)}还没有观影记录<br />点右下角 ＋ 添加一部</div>`;

    $$("[data-act]", list).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-id]");
        const item = page.items.find((i) => i.id === row.dataset.id);
        if (btn.dataset.act === "edit") return this.editSheet(item);
        if (btn.dataset.act === "advance") {
          const next = item.status === "plan" ? "watching" : "done";
          await api.updateMedia(item.id, { status: next, watched_on: next === "done" ? today() : "" });
          toast("已更新状态", "ok");
          this.refresh();
        }
        if (btn.dataset.act === "delete") {
          const ok = await confirmDialog("删除记录", `确认删除「${item.title}」？`, "删除");
          if (!ok) return;
          await api.deleteMedia(item.id);
          toast("已删除", "ok");
          this.refresh();
        }
      });
    });
  },

  editSheet(item) {
    const editing = Boolean(item);
    openSheet({
      title: editing ? `编辑 · ${item.title}` : "添加影视",
      bodyHtml: `
        <label class="field"><span>标题 *</span><input name="title" value="${editing ? esc(item.title) : ""}" /></label>
        <div class="field-grid">
          <label class="field"><span>类型</span><select name="kind">
            ${meta.kinds.map((k) => `<option value="${k.key}" ${editing && item.kind === k.key ? "selected" : ""}>${esc(k.label)}</option>`).join("")}
          </select></label>
          <label class="field"><span>状态</span><select name="status">
            ${meta.statuses.map((s) => `<option value="${s.key}" ${editing ? (item.status === s.key ? "selected" : "") : (s.key === "done" ? "selected" : "")}>${esc(s.label)}</option>`).join("")}
          </select></label>
        </div>
        <label class="field"><span>评分</span>${starPickerHtml("rating", editing ? item.rating : 0)}</label>
        <div class="field-grid">
          <label class="field"><span>导演 / 主演</span><input name="director" value="${editing ? esc(item.director) : ""}" /></label>
          <label class="field"><span>年份</span><input name="year" inputmode="numeric" value="${editing && item.year ? item.year : ""}" /></label>
        </div>
        <div class="field-grid">
          <label class="field"><span>看到第几季</span><input name="season" inputmode="numeric" value="${editing && item.season ? item.season : ""}" /></label>
          <label class="field"><span>看到第几集</span><input name="episode" value="${editing ? esc(item.episode) : ""}" /></label>
        </div>
        <label class="field"><span>观看日期</span><input name="watched_on" type="date" value="${editing ? item.watched_on : today()}" /></label>
        <label class="field"><span>感受 / 短评</span><textarea name="review" placeholder="看完是什么感觉">${editing ? esc(item.review) : ""}</textarea></label>
        <label class="field"><span>想法 / 摘录</span><textarea name="thoughts" placeholder="台词、联想、启发">${editing ? esc(item.thoughts) : ""}</textarea></label>
        <label class="field"><span>标签（逗号分隔）</span><input name="tags" value="${editing ? esc(item.tags.join(", ")) : ""}" /></label>
        <p class="errline hidden" data-err></p>`,
      submitText: editing ? "保存" : "添加",
      onSubmit: async (form) => {
        const fd = new FormData(form);
        const val = (k) => String(fd.get(k) ?? "").trim();
        if (!val("title")) throw showError(form, "请填写标题");
        const payload = {
          title: val("title"),
          kind: val("kind"),
          status: val("status"),
          rating: Number(val("rating") || 0),
          director: val("director"),
          year: Number(val("year") || 0),
          season: Number(val("season") || 0),
          episode: val("episode"),
          watched_on: val("watched_on"),
          review: val("review"),
          thoughts: val("thoughts"),
          tags: val("tags").split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        };
        try {
          if (editing) await api.updateMedia(item.id, payload);
          else await api.createMedia(payload);
        } catch (err) {
          throw showError(form, err.friendly || err.message);
        }
        toast(editing ? "已保存" : "已添加", "ok");
        await this.refresh();
      },
    });
    bindStarPicker($("#sheet-host"));
  },
};

function showError(form, message) {
  const el = $("[data-err]", form);
  if (el) { el.textContent = message; el.classList.remove("hidden"); }
  toast(message, "error");
  return new Error(message);
}

function rowHtml(i) {
  return `<div class="row" data-id="${i.id}">
    <div class="row-main">
      <div class="row-title">${esc(i.title)}
        <span class="badge">${esc(i.kind_label)}</span>
        ${i.status !== "done" ? `<span class="badge brand">${esc(i.status_label)}</span>` : ""}
      </div>
      <div class="row-sub stars">${esc(i.stars)} ${i.year ? `· ${i.year}` : ""} ${i.director ? `· ${esc(i.director)}` : ""} ${i.watched_on ? `· ${esc(i.watched_on)}` : ""}</div>
      ${i.review ? `<div class="row-sub">“${esc(i.review.slice(0, 60))}”</div>` : ""}
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${i.status !== "done" ? `<button class="btn sm ghost" data-act="advance">${i.status === "plan" ? "开始看" : "看完了"}</button>` : ""}
      <button class="btn sm ghost" data-act="edit">编辑</button>
      <button class="btn sm danger" data-act="delete">删除</button>
    </div>
  </div>`;
}
