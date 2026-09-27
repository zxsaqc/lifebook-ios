// 总览「今天」：把四个模块的一天汇聚在一屏
import { api } from "../api.js";
import { esc, money, hoursText, toast, today, prettyDate, iconTile, emptyIcon } from "../ui.js";

export const dashboard = {
  id: "dashboard",
  title: "今天",
  subtitle: () => today(),
  root: null,

  async mount(root) {
    this.root = root;
    root.innerHTML = `
      <div class="hero" id="db-hero"><div class="hero-label">今天投入</div><div class="hero-value">—</div></div>
      <div class="stats-grid">
        <div class="stat red" id="db-month"><div class="label">本月支出</div><div class="value">—</div></div>
        <div class="stat purple" id="db-sub"><div class="label">订阅 / 月</div><div class="value">—</div></div>
        <div class="stat green" id="db-media"><div class="label">今年看完</div><div class="value">—</div></div>
        <div class="stat brand" id="db-accounts"><div class="label">账号</div><div class="value">—</div></div>
      </div>
      <div class="section-title">今天的流水</div>
      <div class="card" id="db-today"><div class="skeleton"></div></div>
      <div class="section-title">当日想法</div>
      <div class="card" id="db-journal"><div class="skeleton" style="height:60px"></div></div>`;
    await this.refresh();
  },

  async refresh() {
    const root = this.root;
    if (!root) return;
    const day = today();
    const month = day.slice(0, 7);
    const [d, lg, md, ac, mst] = await Promise.all([
      api.dayHours(day).catch(() => null),
      api.ledgerStats(month).catch(() => null),
      api.mediaStats().catch(() => null),
      api.accountStats().catch(() => null),
      api.hoursStats(30).catch(() => null),
    ]);

    const minutes = d?.total_minutes || 0;
    $("#db-hero", root).innerHTML = `
      <div class="hero-label">今天投入</div>
      <div class="hero-value">${hoursText(minutes)}</div>
      <div class="hero-foot">
        <span>${d?.sessions.length || 0} 段记录</span>
        <span>连续 ${mst?.streak_days || 0} 天</span>
        <span>近 30 天 ${mst ? `${mst.total_hours}h` : "—"}</span>
      </div>`;

    $("#db-month .value", root).textContent = lg ? money(lg.expense_total) : "—";
    $("#db-sub .value", root).textContent = lg ? `¥${lg.subscription_monthly_cost}` : "—";
    $("#db-media .value", root).textContent = md ? md.watched_this_year : "—";
    $("#db-accounts .value", root).textContent = ac ? ac.total : "—";

    const rows = [];
    (d?.sessions || []).forEach((s) => rows.push({
      tile: iconTile("clock", "brand"),
      title: `${s.project} · ${hoursText(s.minutes)}`,
      sub: s.content || "记了一段工时",
      amount: "",
    }));

    const txPage = await api.listTransactions({ month, limit: 5 }).catch(() => null);
    (txPage?.items || [])
      .filter((t) => String(t.paid_at).startsWith(day))
      .forEach((t) => rows.push({
        tile: iconTile(
          t.is_subscription ? "card" : "receipt",
          t.direction === "income" ? "income" : t.is_subscription ? "amber" : "expense"
        ),
        title: `${t.feeling ? t.feeling + " " : ""}${t.merchant || t.category_label}`,
        sub: `${t.category_label}${t.idea ? ` · ${t.idea}` : ""}`,
        amount: `${t.direction === "income" ? "+" : "−"}${money(t.amount_minor).slice(1)}`,
        cls: t.direction === "income" ? "income" : "expense",
      }));

    const recentMedia = await api.listMedia({ sort: "watched_on", limit: 3 }).catch(() => null);
    (recentMedia?.items || []).forEach((m) => rows.push({
      tile: iconTile("film", "violet"),
      title: `${m.title} ${m.stars}`,
      sub: `${m.kind_label}${m.review ? ` · ${m.review}` : ""}`,
      amount: "",
    }));

    $("#db-today", root).innerHTML = rows.length
      ? `<div class="rows">${rows.map((r) => `
          <div class="row">
            ${r.tile}
            <div class="row-main">
              <div class="row-title">${esc(r.title)}</div>
              <div class="row-sub">${esc(r.sub)}</div>
            </div>
            ${r.amount ? `<div class="row-amt ${r.cls || ""}">${esc(r.amount)}</div>` : ""}
          </div>`).join("")}</div>`
      : `<div class="empty">${emptyIcon("sun", 34)}今天还是空白<br />去记一笔工时、账单或影视吧</div>`;

    $("#db-journal", root).innerHTML = d?.journal
      ? `<div class="row-title">${esc(prettyDate(d.journal.day))} 的想法</div>
         <div style="margin-top:6px;white-space:pre-wrap">${esc(d.journal.summary)}</div>
         ${d.journal.highlights ? `<div class="row-sub" style="margin-top:8px">✨ ${esc(d.journal.highlights)}</div>` : ""}`
      : `<div class="empty" style="padding:18px 0">今天还没有写想法，去「工时」页记录吧</div>`;
  },
};

export function notifyError(err) {
  toast(err.friendly || err.message, "error");
}
