// 账号本子视图
import { api } from "../api.js";
import {
  $, $$, esc, openSheet, confirmDialog, toast, today, emptyIcon,
} from "../ui.js";

let categories = [];
let query = { q: "", category: "", favorite: false, limit: 60, offset: 0 };

export const accounts = {
  id: "accounts",
  title: "账号本子",
  subtitle: "口令本地加密保存",
  root: null,

  async mount(root) {
    this.root = root;
    root.innerHTML = `
      <div class="card">
        <input id="ac-search" placeholder="搜索平台 / 账号 / 备注 / 标签" />
        <div class="chips" style="margin-top:10px" id="ac-cats"></div>
      </div>
      <div id="ac-stats" class="stats-grid"></div>
      <div class="card" id="ac-list"><div class="skeleton"></div></div>`;

    $("#ac-search", root).addEventListener("input", (e) => {
      clearTimeout(this._t);
      const v = e.target.value;
      this._t = setTimeout(() => { query.q = v; query.offset = 0; this.refresh(); }, 280);
    });

    categories = await api.accountCategories().catch(() => []);
    $("#ac-cats", root).innerHTML =
      `<button class="chip active" data-cat="">全部分类</button>` +
      categories.map((c) => `<button class="chip" data-cat="${c.key}">${esc(c.label)}</button>`).join("");
    $$("#ac-cats .chip", root).forEach((chip) => {
      chip.addEventListener("click", () => {
        $$("#ac-cats .chip", root).forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        query.category = chip.dataset.cat;
        query.offset = 0;
        this.refresh();
      });
    });

    await this.refresh();
  },

  async refresh() {
    const root = this.root;
    if (!root) return;
    const [page, stats] = await Promise.all([
      api.listAccounts(query),
      api.accountStats().catch(() => null),
    ]);

    if (stats) {
      $("#ac-stats", root).innerHTML = `
        <div class="stat"><div class="label">账号总数</div><div class="value">${stats.total}</div></div>
        <div class="stat orange"><div class="label">弱口令</div><div class="value">${stats.weak_password_count}</div><div class="foot">建议尽快更换</div></div>
        <div class="stat red"><div class="label">未设口令</div><div class="value">${stats.no_password_count}</div></div>
        <div class="stat brand"><div class="label">重复账号组</div><div class="value">${stats.duplicate_username_groups}</div></div>`;
    }

    const list = $("#ac-list", root);
    if (!page.items.length) {
      list.innerHTML = `<div class="empty">${emptyIcon("key", 34)}还没有账号记录<br />点右下角 ＋ 添加第一个</div>`;
      return;
    }
    list.innerHTML = `<div class="rows">${page.items.map(rowHtml).join("")}</div>`;

    $$("[data-act]", list).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest("[data-id]");
        const id = card.dataset.id;
        const act = btn.dataset.act;
        const item = page.items.find((i) => i.id === id);
        if (act === "reveal") await toggleReveal(card, id, btn);
        if (act === "copy") await copySecret(card, id);
        if (act === "edit") this.editSheet(item);
        if (act === "fav") {
          await api.updateAccount(id, { is_favorite: !item.is_favorite }).catch(() => toast("操作失败", "error"));
          this.refresh();
        }
        if (act === "delete") {
          const ok = await confirmDialog("删除账号", `确认删除「${item.platform}」这条记录？`, "删除");
          if (!ok) return;
          await api.deleteAccount(id).catch(() => toast("删除失败", "error"));
          toast("已删除", "ok");
          this.refresh();
        }
      });
    });
  },

  editSheet(item) {
    const editing = Boolean(item);
    openSheet({
      title: editing ? `编辑 · ${item.platform}` : "新增账号",
      bodyHtml: `
        <label class="field"><span>平台 / 应用 *</span>
          <input name="platform" required value="${editing ? esc(item.platform) : ""}" placeholder="例如 GitHub" /></label>
        <div class="field-grid">
          <label class="field"><span>分类</span><select name="category">
            ${categories.map((c) => `<option value="${c.key}" ${editing && item.category === c.key ? "selected" : ""}>${esc(c.label)}</option>`).join("")}
          </select></label>
          <label class="field"><span>网址</span><input name="url" value="${editing ? esc(item.url) : ""}" placeholder="https://" /></label>
        </div>
        <label class="field"><span>账号 / 邮箱</span><input name="username" value="${editing ? esc(item.username) : ""}" /></label>
        <label class="field"><span>口令</span><input name="password" type="password" placeholder="${editing && item.password_set ? "留空表示不修改" : ""}" /></label>
        <label class="field"><span>二次验证密钥（可选）</span><input name="totp_secret" placeholder="TOTP secret" /></label>
        <label class="field"><span>标签（逗号分隔）</span><input name="tags" value="${editing ? esc(item.tags.join(", ")) : ""}" /></label>
        <label class="field"><span>备注</span><textarea name="notes">${editing ? esc(item.notes) : ""}</textarea></label>
        <p class="errline hidden" data-err></p>`,
      submitText: editing ? "保存" : "添加",
      onSubmit: async (form) => {
        const fd = new FormData(form);
        const val = (k) => String(fd.get(k) ?? "").trim();
        if (!val("platform")) throw showError(form, "请填写平台名称");
        const payload = {
          platform: val("platform"),
          category: val("category"),
          username: val("username"),
          url: val("url"),
          notes: val("notes"),
          tags: val("tags").split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        };
        const pw = val("password");
        if (!editing || pw) payload.password = pw;
        const totp = val("totp_secret");
        if (totp) payload.totp_secret = totp;
        try {
          if (editing) await api.updateAccount(item.id, payload);
          else await api.createAccount(payload);
        } catch (err) {
          throw showError(form, err.friendly || err.message);
        }
        toast(editing ? "已保存" : "已添加", "ok");
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
  return `<div class="row" data-id="${i.id}">
    <div class="row-main">
      <div class="row-title">${esc(i.platform)}
        <span class="badge">${esc(i.category_label)}</span>
        ${i.is_favorite ? '<span class="badge warn">★</span>' : ""}
      </div>
      <div class="row-sub">${i.username ? esc(i.username) : "未填写账号"}</div>
      <div class="secret-row" style="display:flex;gap:8px;margin-top:8px">
        <span class="secret-box" data-role="secret" data-open="0">••••••••</span>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <button class="btn sm ghost" data-act="reveal">显示</button>
      <button class="btn sm ghost" data-act="copy">复制</button>
      <button class="btn sm ghost" data-act="edit">编辑</button>
      <button class="btn sm danger" data-act="delete">删除</button>
    </div>
  </div>`;
}

async function toggleReveal(card, id, btn) {
  const box = $('[data-role="secret"]', card);
  if (box.dataset.open === "1") {
    box.textContent = "••••••••";
    box.dataset.open = "0";
    btn.textContent = "显示";
    return;
  }
  try {
    const data = await api.revealAccount(id);
    box.textContent = data.password || "（未设置）";
    box.dataset.open = "1";
    btn.textContent = "隐藏";
    setTimeout(() => {
      if (box.dataset.open === "1") {
        box.textContent = "••••••••";
        box.dataset.open = "0";
        btn.textContent = "显示";
      }
    }, 15000);
  } catch {
    toast("解锁失败，请重新解锁账库", "error");
  }
}

async function copySecret(card, id) {
  try {
    const box = $('[data-role="secret"]', card);
    let text = box.textContent;
    if (box.dataset.open !== "1") {
      const data = await api.revealAccount(id);
      text = data.password || "";
    }
    await navigator.clipboard.writeText(text);
    toast("已复制口令", "ok");
  } catch {
    toast("复制失败", "error");
  }
}

export const helpers = { today };
