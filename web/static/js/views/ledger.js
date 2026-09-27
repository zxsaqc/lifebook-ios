// 记账视图：月度概览 + AI 自动识别 + 想法/感受/照片
import { api } from "../api.js";
import {
  $, $$, esc, money, moneyShort, openSheet, confirmDialog, toast,
  prettyDate, nowMonth, nowDateTimeLocal, today,
} from "../ui.js";

let categories = [];
let month = nowMonth();
let filter = { q: "", category: "", subscription: false, limit: 40, offset: 0 };

export const ledger = {
  id: "ledger",
  title: "记账",
  subtitle: () => month,
  root: null,

  async mount(root) {
    this.root = root;
    categories = await api.ledgerCategories().catch(() => []);
    root.innerHTML = `
      <div class="hero" id="lg-hero"><div class="hero-label">本月支出</div><div class="hero-value">—</div></div>
      <div class="stats-grid">
        <div class="stat green" id="lg-income"><div class="label">收入</div><div class="value">—</div></div>
        <div class="stat purple" id="lg-sub"><div class="label">💳 会员订阅 / 月</div><div class="value">—</div><div class="foot" id="lg-sub-foot"></div></div>
        <div class="stat brand" id="lg-ai"><div class="label">AI 命中率</div><div class="value">—</div><div class="foot">自动打标占比</div></div>
        <div class="stat orange" id="lg-top"><div class="label">最大开销</div><div class="value">—</div></div>
      </div>
      <div class="card" id="lg-cats"><div class="section-title">分类占比</div></div>
      <div class="chips" id="lg-filter">
        <button class="chip active" data-all>全部</button>
        <button class="chip" data-sub>仅会员订阅</button>
        ${categories.map((c) => `<button class="chip" data-cat="${c.key}">${esc(c.label)}</button>`).join("")}
      </div>
      <div class="card" id="lg-list"><div class="skeleton"></div></div>`;

    $$("#lg-filter .chip", root).forEach((chip) => {
      chip.addEventListener("click", () => {
        $$("#lg-filter .chip", root).forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        filter.category = chip.dataset.cat || "";
        filter.subscription = Boolean(chip.dataset.sub);
        filter.offset = 0;
        this.refresh();
      });
    });

    await this.refresh();
  },

  async refresh() {
    const root = this.root;
    if (!root) return;
    const [stats, page] = await Promise.all([
      api.ledgerStats(month),
      api.listTransactions({ ...filter, month, limit: 40 }),
    ]);

    const hero = $("#lg-hero", root);
    $(".hero-value", hero).textContent = money(stats.expense_total);
    $(".hero-label", hero).textContent = `${stats.month} 支出`;
    $(".hero-foot", hero)?.remove();
    hero.insertAdjacentHTML("beforeend",
      `<div class="hero-foot"><span>结余 ${money(stats.net)}</span><span>共 ${page.total} 笔</span></div>`);

    $("#lg-income .value", root).textContent = money(stats.income_total);
    $("#lg-sub .value", root).textContent = `¥${stats.subscription_monthly_cost}`;
    $("#lg-sub-foot", root).textContent = `${stats.subscription_count} 笔订阅`;
    $("#lg-ai .value", root).textContent = `${stats.ai_hit_rate ?? 0}%`;

    const cats = Object.entries(stats.by_category || {}).sort((a, b) => b[1] - a[1]);
    const top = cats[0];
    $("#lg-top .value", root).textContent = top ? top[0] : "—";
    $("#lg-top .foot", root)?.remove();
    $("#lg-cats", root).innerHTML = `<div class="section-title">分类占比</div>` + (
      cats.length
        ? `<div class="bar-wrap">${cats.slice(0, 6).map(([k, v]) => {
            const label = categories.find((c) => c.key === k)?.label || k;
            const max = cats[0][1] || 1;
            return `<div class="bar-row">
              <span class="bar-name">${esc(label)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, Math.round(v / max * 100))}%"></span></span>
              <span class="bar-val">${moneyShort(v)}</span>
            </div>`;
          }).join("")}</div>`
        : `<div class="empty">本月还没有记账</div>`
    );

    const list = $("#lg-list", root);
    if (!page.items.length) {
      list.innerHTML = `<div class="empty"><span class="big">🧾</span>还没有账单<br />点右下角 ＋ 记一笔</div>`;
      return;
    }
    list.innerHTML = page.items.map(rowHtml).join("");
    $$("[data-act]", list).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest("[data-id]");
        const id = card.dataset.id;
        const item = page.items.find((i) => i.id === id);
        if (btn.dataset.act === "edit") return this.editSheet(item);
        if (btn.dataset.act === "photo") return this.photoSheet(item);
        if (btn.dataset.act === "delete") {
          const ok = await confirmDialog("删除账单", `确认删除「${item.merchant || "这笔"} ${money(item.amount_minor)}」？`, "删除");
          if (!ok) return;
          await api.deleteTransaction(id).catch(() => toast("删除失败", "error"));
          toast("已删除", "ok");
          this.refresh();
        }
      });
    });
  },

  editSheet(item) {
    const editing = Boolean(item);
    openSheet({
      title: editing ? "编辑账单" : "记一笔",
      bodyHtml: `
        <label class="field"><span>金额 *</span><input name="amount" inputmode="decimal" placeholder="0.00" value="${editing ? item.amount : ""}" /></label>
        <label class="field"><span>商户 / 描述</span><input name="merchant" value="${editing ? esc(item.merchant) : ""}" placeholder="输入时会自动识别，例如 Netflix" /></label>
        <div id="ai-hint" class="hintline" style="color:var(--brand)"></div>
        <div class="field-grid">
          <label class="field"><span>分类</span><select name="category">
            <option value="">自动识别</option>
            ${categories.map((c) => `<option value="${c.key}" ${editing && item.category === c.key ? "selected" : ""}>${esc(c.label)}</option>`).join("")}
          </select></label>
          <label class="field"><span>方向</span><select name="direction">
            <option value="expense" ${!editing || item.direction === "expense" ? "selected" : ""}>支出</option>
            <option value="income" ${editing && item.direction === "income" ? "selected" : ""}>收入</option>
          </select></label>
        </div>
        <div class="field-grid">
          <label class="field"><span>支付方式</span><input name="method" value="${editing ? esc(item.method) : ""}" placeholder="微信 / 支付宝 / 招行" /></label>
          <label class="field"><span>时间</span><input name="paid_at" type="datetime-local" value="${editing ? item.paid_at.slice(0, 16) : nowDateTimeLocal()}" /></label>
        </div>
        <label class="field"><span>当时的想法</span><textarea name="idea" placeholder="为什么会花这笔钱？">${editing ? esc(item.idea) : ""}</textarea></label>
        <label class="field"><span>感受</span>
          <select name="feeling">
            ${["", "🥰", "😌", "😐", "😞", "😤", "🤔", "🎉"].map((f) => `<option value="${f}" ${editing && item.feeling === f ? "selected" : ""}>${f || "不记录"}</option>`).join("")}
          </select></label>
        <label class="field"><span>标签（逗号分隔）</span><input name="tags" value="${editing ? esc(item.tags.join(", ")) : ""}" /></label>
        <p class="errline hidden" data-err></p>`,
      extraButton: editing ? "上传照片" : undefined,
      submitText: editing ? "保存" : "记下来",
      onSubmit: async (form) => {
        const fd = new FormData(form);
        const val = (k) => String(fd.get(k) ?? "").trim();
        const amount = val("amount");
        if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount)) throw showError(form, "金额格式不正确，例如 68.00");
        const payload = {
          amount,
          merchant: val("merchant"),
          direction: val("direction"),
          method: val("method"),
          idea: val("idea"),
          feeling: val("feeling"),
          paid_at: val("paid_at") ? new Date(val("paid_at")).toISOString() : new Date().toISOString(),
          tags: val("tags").split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        };
        const cat = val("category");
        if (cat) payload.category = cat;
        try {
          if (editing) await api.updateTransaction(item.id, payload);
          else await api.createTransaction(payload);
        } catch (err) {
          throw showError(form, err.friendly || err.message);
        }
        toast(editing ? "已保存" : "已记账", "ok");
        await this.refresh();
      },
    });

    // AI 实时预判：输入商户或金额后 debounce 调用
    const sheet = $("#sheet-host");
    const merchantInput = $('input[name="merchant"]', sheet);
    const amountInput = $('input[name="amount"]', sheet);
    const hint = $("#ai-hint", sheet);
    let timer = null;
    const run = async () => {
      const merchant = merchantInput.value.trim();
      const amount = amountInput.value.trim() || "0";
      if (!merchant && amount === "0") { hint.textContent = ""; return; }
      try {
        const r = await api.ledgerPreview(merchant, amount);
        const period = { monthly: "每月", yearly: "每年", weekly: "每周", quarterly: "每季" }[r.period] || "";
        hint.innerHTML = r.is_subscription
          ? `🤖 识别为<strong>会员订阅</strong> · ${esc(r.matched_service)} ${period} · 置信度 ${Math.round(r.confidence * 100)}%<br /><span style="color:var(--text-dim)">${esc(r.reasons.join("；"))}</span>`
          : `🤖 建议归类「${esc(r.category_label)}」· 置信度 ${Math.round(r.confidence * 100)}%<br /><span style="color:var(--text-dim)">${esc(r.reasons.join("；"))}</span>`;
      } catch {
        hint.textContent = "";
      }
    };
    [merchantInput, amountInput].forEach((el) =>
      el.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 350); })
    );

    window.addEventListener("sheet:extra", async () => {
      if (!editing) return;
      await this.photoSheet(item);
    }, { once: true });
  },

  photoSheet(item) {
    openSheet({
      title: "凭证照片",
      bodyHtml: `
        <div class="photos" id="pv">
          ${item.attachments.map((a) => `<img src="${esc(a.thumb_url)}" alt="${esc(a.file_name)}" data-id="${a.id}" />`).join("") || '<div class="hintline">还没有照片</div>'}
        </div>
        <label class="field" style="margin-top:14px"><span>添加照片</span>
          <input type="file" accept="image/*" name="file" /></label>
        <p class="hintline">自动压缩并生成缩略图，原图也保存在本机。</p>`,
      submitText: "上传所选照片",
      onSubmit: async (form) => {
        const fileEl = $('input[type=file]', form);
        if (!fileEl.files.length) throw showError(form, "请先选择一张图片");
        try {
          await api.uploadReceipt(item.id, fileEl.files[0]);
        } catch (err) {
          throw showError(form, err.friendly || err.message);
        }
        toast("已上传", "ok");
        const fresh = await api.getTransaction(item.id);
        Object.assign(item, fresh);
        await this.photoSheet(item);
        await this.refresh();
      },
    });
  },
};

function showError(form, message) {
  const el = $("[data-err]", form);
  if (el) { el.textContent = message; el.classList.remove("hidden"); }
  toast(message, "error");
  return new Error(message);
}

function rowHtml(i) {
  const isSub = i.is_subscription;
  return `<div class="row" data-id="${i.id}">
    <div class="row-main">
      <div class="row-title">
        ${i.feeling ? `<span>${esc(i.feeling)}</span>` : ""}
        ${esc(i.merchant || i.category_label)}
        ${isSub ? '<span class="badge purple">订阅</span>' : `<span class="badge">${esc(i.category_label)}</span>`}
      </div>
      <div class="row-sub">${esc(prettyDate(i.paid_at))}${i.method ? ` · ${esc(i.method)}` : ""}${i.idea ? ` · ${esc(i.idea)}` : ""}</div>
      ${i.attachments.length ? `<div class="photos">${i.attachments.map((a) => `<img src="${esc(a.thumb_url)}" alt="" />`).join("")}</div>` : ""}
    </div>
    <div class="row-amt ${i.direction === "income" ? "income" : "expense"}">
      ${i.direction === "income" ? "+" : "−"}${money(i.amount_minor).slice(1)}
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <button class="btn sm ghost" data-act="edit">编辑</button>
      <button class="btn sm ghost" data-act="photo">照片</button>
      <button class="btn sm danger" data-act="delete">删除</button>
    </div>
  </div>`;
}

export { today };
