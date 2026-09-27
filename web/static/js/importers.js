// LifeBook 导入中转层：把别处导出的数据转成 LifeBook 能存进去的记录。
//
// 为什么要有这一层：让人换软件最大的阻力不是功能，是「我里面那些东西怎么办」。
// 迁移成本降下来，推广才有可能。所以这里的目标很直白 —— 尽量把用户已有的数据接过来。
//
// 三个设计决定：
//
// 1. **结构无关的字段归一，而不是为每个 App 写死解析器。**
//    起因是查「账号本子」这类国产 App：它们的导出有明文 JSON、有 CSV、还有「长按复制文本」，
//    而且每家的字段名都不一样。逐个适配永远追不上。所以真正的核心是一张别名表 ——
//    把「账号/帐号/用户名/username/login/手机号」都归到同一个内部字段。
//    于是不管外层套着什么名字，只要里面有账号密码这种键值对，就能认出来。
//    具名识别（微信/支付宝/Chrome…）只用来**告诉用户「我认出来这是什么」**，不决定怎么解析。
//
// 2. **认错比认不出更糟。** 所以识别结果带置信度、理由和逐条预览，
//    模块判错时界面上能手动改。宁可让用户多点一下，也不要默默把数据塞错地方。
//
// 3. **解析器是纯函数。** 不碰 DOM、不碰数据层、不碰网络，所以可以直接在 Node 里跑测试。
//    本机装不了浏览器自动化，这是唯一能验证导入正确性的途径。

import {
  CATEGORY_LABELS,
  accountCategoryKey,
  ledgerCategoryKey,
} from "./rules.js";

export const MODULES = {
  account: "账号本子",
  ledger: "记账",
  hours: "工时记录",
  media: "影视观影",
};

/* ==================== 一、文本与编码 ==================== */

/** 去掉 BOM、统一换行、去掉零宽字符。 */
export function normalizeText(input) {
  return String(input ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

export function snip(text, n = 40) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 字节 → 文本，带编码嗅探。
 *
 * 必须处理 GBK：微信、支付宝导出的账单，以及 Excel「另存为 CSV」的结果，
 * 在国内基本都是 GBK。直接用 UTF-8 解会得到满屏问号，而且**不会报错**，
 * 数据看上去是导入成功了，实际全是乱码 —— 这种失败最难发现，所以要显式嗅探。
 */
export function decodeBytes(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!buf.length) return { text: "", encoding: "empty" };

  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: normalizeText(new TextDecoder("utf-8").decode(buf.subarray(3))), encoding: "utf-8-bom" };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: normalizeText(new TextDecoder("utf-16le").decode(buf.subarray(2))), encoding: "utf-16le" };
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: normalizeText(new TextDecoder("utf-16be").decode(buf.subarray(2))), encoding: "utf-16be" };
  }

  // 严格的 UTF-8 解码：合法就一定是 UTF-8（GBK 文本几乎不可能碰巧是合法 UTF-8）
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text: normalizeText(text), encoding: "utf-8" };
  } catch {
    /* 落到下一档 */
  }
  try {
    const text = new TextDecoder("gbk").decode(buf);
    if (!text.includes("\uFFFD")) return { text: normalizeText(text), encoding: "gbk" };
  } catch {
    /* 运行环境没有 gbk 解码器 */
  }
  return { text: normalizeText(new TextDecoder("utf-8").decode(buf)), encoding: "utf-8-lossy" };
}

/* ==================== 二、表格解析 ==================== */

/** 猜分隔符：看第一行里哪个候选字符出现得最多。 */
export function detectDelimiter(text, candidates = [",", "\t", ";", "|"]) {
  const firstLine = normalizeText(text).split("\n").find((l) => l.trim()) || "";
  let best = ",";
  let bestCount = 0;
  for (const d of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 解析分隔符文本。自己写而不是用现成库，是因为要处理引号内的逗号和换行 ——
 * 账单备注里一个换行就能把整份文件的行列对错位，这类 bug 极难排查。
 */
export function parseDelimited(text, delimiter = ",") {
  const s = normalizeText(text);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      // 只有出现在字段开头的引号才是「包裹」，避免把 12" 显示器 这种内容截断
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  // 丢掉完全空白的行，但保留列（列数不齐的行后面会补齐）
  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ""));
}

/* ==================== 三、字段归一 ==================== */

/** 归一化字段名：去全角/空白/标点，转小写，便于跨来源比对。 */
export function normKey(raw) {
  return String(raw ?? "")
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角→半角
    .replace(/[（）()【】\[\]「」《》<>]/g, "")
    .replace(/[\s_\-/:：*·.、，,]/g, "")
    .toLowerCase()
    .trim();
}

const COMMON_ALIASES = {
  notes: ["备注", "備註", "注", "说明", "說明", "描述", "附加信息", "附加", "附言", "提示", "备注信息",
    "note", "notes", "remark", "remarks", "memo", "comment", "comments", "description", "desc", "extra"],
  tags: ["标签", "標籤", "tag", "tags", "label", "labels"],
};

/** 各模块的字段别名表。别名越全，用户越不需要手工整理导出文件。 */
const MODULE_ALIASES = {
  account: {
    platform: ["平台", "平台名称", "名称", "标题", "应用", "应用名", "应用名称", "网站", "网站名", "站点",
      "服务", "服务名", "软件", "软件名", "条目", "项目名", "帐号名称",
      "title", "name", "platform", "app", "application", "site", "service", "item", "entry",
      "account_name", "accountname", "displayname"],
    username: ["账号", "帐号", "账户", "帐户", "用户名", "用戶名", "登录名", "登入名", "登录账号", "登陆账号",
      "手机号", "手机", "电话", "邮箱", "邮箱地址", "电子邮箱", "用户", "帐号名", "登录",
      "user", "username", "username", "login", "account", "email", "mail", "phone", "mobile",
      "uid", "user_id", "userid", "account_id", "accountid", "loginname"],
    password: ["密码", "密碼", "口令", "登录密码", "登入密码", "登陆密码", "安全密码", "密码值", "密码内容",
      "password", "pass", "pwd", "passwd", "passcode", "secret", "credential", "credentialspassword"],
    url: ["网址", "網址", "網站", "网站地址", "链接", "链接地址", "地址", "登录地址", "登陆地址", "登录网址",
      "url", "link", "website", "web", "uri", "href", "homepage", "loginuri", "loginurl", "uri地址"],
    totp_secret: ["两步验证", "两步验证密钥", "二次验证", "验证码密钥", "动态密码", "动态口令", "令牌",
      "otp", "totp", "totp_secret", "totpsecret", "two_factor", "twofactor", "2fa", "otpauth",
      "authenticator", "otpsecret", "otp_secret"],
    category: ["分组", "分組", "分类", "分类名", "类别", "类型", "文件夹", "所属分组",
      "group", "folder", "category", "grouping", "type"],
    is_favorite: ["收藏", "星标", "星標", "常用", "置顶", "是否收藏",
      "favorite", "favourite", "starred", "pinned", "star"],
  },
  ledger: {
    paid_at: ["交易时间", "交易時間", "交易创建时间", "创建时间", "付款时间", "支付时间", "记账时间",
      "交易日期", "消费时间", "发生时间", "下单时间", "日期", "时间",
      "date", "time", "datetime", "paid_at", "paidat", "created_at", "createdat",
      "transaction_time", "timestamp", "transdate"],
    merchant: ["交易对方", "交易對方", "对方", "交易对象", "商户", "商戶", "商家", "商户名称", "商户全称",
      "收款方", "付款方", "对方名称", "商品", "商品说明", "商品名称", "商品名", "交易说明", "交易描述",
      "消费项目", "摘要", "用途", "商户单号名",
      "merchant", "payee", "payer", "counterparty", "vendor", "description", "item", "product", "summary"],
    amount: ["金额", "金额元", "交易金额", "发生金额", "收支金额", "消费金额", "价格", "数额", "合计",
      "amount", "money", "price", "value", "total", "amountcny", "sum"],
    direction: ["收/支", "收支", "收/付款", "收支类型", "交易方向", "借贷", "借贷标志", "方向", "收支方向",
      "direction", "flow", "inout"],
    method: ["支付方式", "收/付款方式", "收付款方式", "付款方式", "支付账户", "付款账户", "账户", "渠道",
      "method", "payment", "payment_method", "paymentmethod", "channel", "paymethod", "pay_method"],
    category: ["交易分类", "交易分類", "分类", "类别", "交易类型", "消费类型", "记账分类", "账单分类",
      "category", "categoryname", "billtype"],
    status: ["交易状态", "当前状态", "状态", "status", "state", "tradestatus"],
    currency: ["币种", "货币", "货币类型", "currency"],
    is_subscription: ["是否订阅", "订阅", "是否会员", "subscription", "issubscription", "is_subscription"],
    period: ["周期", "订阅周期", "计费周期", "period", "cycle", "billingcycle"],
  },
  hours: {
    day: ["日期", "工作日期", "记录日期", "日期时间", "时间", "date", "day", "workdate", "work_date"],
    project: ["项目", "项目名", "项目名称", "任务", "任务名", "事项", "工作", "工作项", "主题", "所属项目",
      "project", "task", "item", "subject", "projectname", "taskname"],
    minutes: ["时长分钟", "分钟", "耗时分钟", "工作时长分钟", "minutes", "durationminutes", "minutesworked"],
    hours: ["小时", "工时", "时长", "耗时", "工作时长", "小时数", "时长小时",
      "hours", "hour", "duration", "timespent", "time_spent", "workedhours"],
    mood: ["心情", "情绪", "心情指数", "状态", "mood", "feeling"],
    content: ["内容", "详情", "详细内容", "记录", "工作总结", "工作内容", "描述",
      "content", "detail", "details", "log"],
  },
  media: {
    title: ["标题", "標題", "片名", "名称", "电影名", "剧名", "作品名", "影片", "影片名称", "影视名称",
      "title", "name", "movie", "film", "moviename", "originaltitle"],
    kind: ["类型", "类别", "分类", "影片类型", "作品类型", "影视类型", "媒介",
      "kind", "type", "category", "mediatype", "media_type", "titletype"],
    status: ["观看状态", "状态", "是否看完", "status", "state", "watchedstatus"],
    // 「我的评分」必须排在「评分」前面：豆瓣导出的表里两者都有，
    // 前者才是用户自己的打分，后者是网站的平均分。
    rating: ["我的评分", "我的打分", "个人评分", "我的评价分数", "你的评分",
      "myrating", "my_rating", "yourrating", "userrating", "personalrating",
      "评分", "打分", "星级", "分数", "rating", "score", "stars", "vote", "starrating"],
    watched_on: ["观看日期", "观看时间", "看过日期", "看过时间", "标记时间", "标记日期", "观影日期",
      "观影时间", "看完日期", "日期", "时间",
      "watched", "watched_on", "watchedon", "watched_date", "watchdate", "daterated", "date"],
    review: ["短评", "评价", "评论", "影评", "观后感", "简评",
      "review", "comment", "remark"],
    thoughts: ["想法", "感受", "心得", "感悟", "笔记", "thoughts", "feeling", "feelings", "impression"],
    director: ["导演", "導演", "主创", "导演名", "director", "directors"],
    year: ["年份", "上映年份", "上映日期", "发行年份", "发布年份", "year", "releaseyear", "release_year", "release"],
    season: ["季", "季数", "第几季", "season", "seasonnumber", "season_number"],
    episode: ["集", "集数", "集数进度", "第几集", "episode", "ep", "episodenumber"],
    poster_url: ["海报", "海报地址", "海报链接", "封面", "封面地址", "poster", "posterurl", "poster_url",
      "cover", "image", "imageurl"],
  },
};

// 合并公共别名
for (const table of Object.values(MODULE_ALIASES)) {
  for (const [k, v] of Object.entries(COMMON_ALIASES)) {
    table[k] = [...(table[k] || []), ...v];
  }
}

// 归一化后的反向索引：别名 → { 标准字段名, 优先次序 }
// 带上次序是因为一个字段的多个别名有优劣之分：列名同时出现「评分」和「我的评分」时，
// 「我的评分」才该被采用。序号小的赢。
const ALIAS_INDEX = {};
for (const [mod, table] of Object.entries(MODULE_ALIASES)) {
  const idx = new Map();
  for (const [canonical, names] of Object.entries(table)) {
    [canonical, ...names].forEach((n, order) => {
      const key = normKey(n);
      if (!key) return;
      const prev = idx.get(key);
      if (!prev || order < prev.order) idx.set(key, { canonical, order });
    });
  }
  ALIAS_INDEX[mod] = idx;
}

// 跨模块的完整别名集合，用于「这一格是不是字段名」这类判断
const ALL_ALIAS_KEYS = new Set();
for (const idx of Object.values(ALIAS_INDEX)) {
  for (const k of idx.keys()) ALL_ALIAS_KEYS.add(k);
}

/** 某个归一化后的键，是不是一个我们认识的字段名。 */
export function isKnownFieldName(raw) {
  return ALL_ALIAS_KEYS.has(normKey(raw));
}

/**
 * 把一个「键名随便叫什么」的对象，映射成标准字段。
 * 匹配顺序：精确命中 → 包含命中；每个标准字段只取第一个命中的来源列。
 */
export function canonicalFields(obj, module) {
  const idx = ALIAS_INDEX[module] || ALIAS_INDEX.account;
  const entries = Object.entries(obj || {}).map(([k, v]) => [k, normKey(k), v]);
  const out = {};
  const used = new Set();

  // 第一轮：精确命中。同一个标准字段被多列命中时，取别名次序最小的那列
  //（「我的评分」要赢过「评分」）。
  const best = new Map();
  for (const [rawKey, key, value] of entries) {
    const hit = idx.get(key);
    if (!hit) continue;
    const cur = best.get(hit.canonical);
    if (!cur || hit.order < cur.order) best.set(hit.canonical, { order: hit.order, value, rawKey });
  }
  for (const [canonical, rec] of best) {
    out[canonical] = rec.value;
    used.add(rec.rawKey);
  }

  // 第二轮：兜底那些带后缀的列名，比如「金额（元）」「交易金额（人民币）」。
  // 只做正向包含（列名包含别名），避免短列名被长别名反向吞掉。
  for (const [rawKey, key] of entries) {
    if (used.has(rawKey) || !key) continue;
    let chosen = null;
    for (const [alias, hit] of idx) {
      if (alias.length < 2 || !key.includes(alias)) continue;
      if (hit.canonical in out) continue;
      if (!chosen || hit.order < chosen.order) chosen = { canonical: hit.canonical, order: hit.order };
    }
    if (chosen) {
      out[chosen.canonical] = obj[rawKey];
      used.add(rawKey);
    }
  }
  return out;
}

/* ==================== 四、值清洗 ==================== */

const stripped = (v) => String(v ?? "").trim();

/** 金额 → 分（整数）。外部导出的写法五花八门：¥1,234.56 / -12.00 / (12.00) / 12元 */
export function toMinor(input) {
  if (typeof input === "number" && Number.isFinite(input)) return Math.round(input * 100);
  let s = stripped(input);
  if (!s) return 0;
  let negative = false;
  if (/^[(（].*[)）]$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/^[-−—]/.test(s)) {
    negative = true;
    s = s.slice(1);
  }
  s = s.replace(/(人民币|元|rmb|cny)/gi, "").replace(/[¥￥$€£,\s]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.abs(n) * 100) * (negative ? -1 : 1);
}

/** 各种日期写法 → ISO（不带时区，和本机数据层的口径一致）。 */
export function cleanDate(input) {
  const s = stripped(input);
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.length === 16 ? `${s}:00` : s.slice(0, 19);

  const m = s.match(
    /^(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?(?:[ T]*(\d{1,2})\s*[:时点]\s*(\d{1,2})?(?:\s*[:分]\s*(\d{1,2}))?)?/
  );
  if (m) {
    const pad = (v, d = "00") => String(v ?? d).padStart(2, "0");
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${pad(m[5])}:${pad(m[6])}`;
  }
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})(?:\s*(\d{2})(\d{2})(\d{2})?)?$/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4] || "00"}:${compact[5] || "00"}:${compact[6] || "00"}`;
  }
  // Excel 序列号（1900 纪元）：40000 附近对应 2009 年，覆盖日常账单范围
  if (/^\d{5}$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 60000) {
      const ms = Date.UTC(1899, 11, 30) + n * 86400000;
      const d = new Date(ms);
      const pad = (v) => String(v).padStart(2, "0");
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00:00`;
    }
  }
  const short = s.match(/^(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?$/);
  if (short) {
    const y = new Date().getFullYear();
    return `${y}-${String(short[1]).padStart(2, "0")}-${String(short[2]).padStart(2, "0")}T00:00:00`;
  }
  return "";
}

/** 账单里的「收/支」列 → 内部方向。 */
export function cleanDirection(input) {
  const s = stripped(input).toLowerCase();
  if (!s || s === "/" || s === "-") return "";
  if (/(支出|付款|支付成功|转出|借|扣款|消费|expense|debit|out)/.test(s)) return "expense";
  if (/(收入|收款|转入|贷|退款|income|credit|in)/.test(s) && !/不计/.test(s)) return "income";
  if (/不计收支|中性|其他/.test(s)) return "expense";
  return "";
}

/** 星级 / 分数 → 0~10。返回 needScale 表示「按 5 分制换算过」。 */
export function cleanRating(input) {
  const s = stripped(input);
  if (!s || s === "/" || s === "-") return { value: 0, scaled: false };
  const stars = (s.match(/★/g) || []).length + (s.match(/⭐/g) || []).length;
  if (stars > 0) return { value: Math.min(10, stars * 2), scaled: true };
  const n = Number(s.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return { value: 0, scaled: false };
  if (n <= 0) return { value: 0, scaled: false };
  if (n <= 5) return { value: Math.round(n * 2 * 10) / 10, scaled: true };
  return { value: Math.min(10, Math.round(n * 10) / 10), scaled: false };
}

/** 时长 → 分钟。列名带单位时按单位算，否则按数值大小猜（并在结果里说明）。 */
export function toMinutes(value, unit) {
  const n = Number(stripped(value).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (unit === "hours") return Math.round(n * 60);
  if (unit === "minutes") return Math.round(n);
  return n <= 24 ? Math.round(n * 60) : Math.round(n);
}

export function cleanKind(input, title = "") {
  const s = `${stripped(input)} ${stripped(title)}`.toLowerCase();
  if (/(纪录片|documentary|doc\b)/.test(s)) return "doc";
  if (/(动画|动漫|番剧|anime|animation|cartoon)/.test(s)) return "anime";
  if (/(电视剧|剧集|连续剧|美剧|英剧|日剧|韩剧|综艺|tv|series|episode|season)/.test(s)) return "tv";
  if (/(电影|movie|film)/.test(s)) return "movie";
  return "movie";
}

export function cleanStatus(input) {
  const s = stripped(input).toLowerCase();
  if (/(想看|待看|计划|plan|wishlist|towatch|to_watch)/.test(s)) return "plan";
  if (/(在看|追剧|进行|watching|inprogress|in_progress)/.test(s)) return "watching";
  if (/(弃|半途|dropped|abandoned)/.test(s)) return "dropped";
  if (/(看完|已看|看过|done|watched|completed|finished)/.test(s)) return "done";
  return "";
}

/* ==================== 五、URL / 域名推断 ==================== */

// 常见站点：域名关键词 → 平台名 + 账号分类。
// 很多密码管理器的导出只有 URL，这一层负责把 www.zhihu.com 变成「知乎 / 社交」。
const DOMAIN_HINTS = [
  { keys: ["zhihu"], platform: "知乎", category: "social" },
  { keys: ["weibo"], platform: "微博", category: "social" },
  { keys: ["douban"], platform: "豆瓣", category: "social" },
  { keys: ["xiaohongshu", "xhscdn"], platform: "小红书", category: "social" },
  { keys: ["douyin", "tiktok"], platform: "抖音", category: "social" },
  { keys: ["bilibili", "b23"], platform: "哔哩哔哩", category: "gaming" },
  { keys: ["qq.com", "tencent"], platform: "腾讯", category: "social" },
  { keys: ["weixin", "wechat"], platform: "微信", category: "social" },
  { keys: ["taobao", "tmall", "alicdn"], platform: "淘宝", category: "shopping" },
  { keys: ["jd.com", "jingdong"], platform: "京东", category: "shopping" },
  { keys: ["pinduoduo", "yangkeduo"], platform: "拼多多", category: "shopping" },
  { keys: ["alipay", "alibaba"], platform: "支付宝", category: "finance" },
  { keys: ["icbc", "ccb.com", "abchina", "boc.cn", "cmbchina", "bank"], platform: "银行", category: "finance" },
  { keys: ["paypal"], platform: "PayPal", category: "finance" },
  { keys: ["google"], platform: "Google", category: "email" },
  { keys: ["gmail"], platform: "Gmail", category: "email" },
  { keys: ["outlook", "microsoft", "office", "live.com", "msn"], platform: "Microsoft", category: "work" },
  { keys: ["apple", "icloud"], platform: "Apple", category: "other" },
  { keys: ["163.com", "126.com", "yeah.net"], platform: "网易邮箱", category: "email" },
  { keys: ["qq邮箱", "mail.qq"], platform: "QQ邮箱", category: "email" },
  { keys: ["github"], platform: "GitHub", category: "dev" },
  { keys: ["gitlab"], platform: "GitLab", category: "dev" },
  { keys: ["gitee"], platform: "Gitee", category: "dev" },
  { keys: ["aliyun", "aliyuncs"], platform: "阿里云", category: "dev" },
  { keys: ["tencentcloud", "qcloud"], platform: "腾讯云", category: "dev" },
  { keys: ["cloudflare"], platform: "Cloudflare", category: "dev" },
  { keys: ["vercel"], platform: "Vercel", category: "dev" },
  { keys: ["openai", "chatgpt"], platform: "OpenAI", category: "subscription" },
  { keys: ["netflix"], platform: "Netflix", category: "subscription" },
  { keys: ["spotify"], platform: "Spotify", category: "subscription" },
  { keys: ["steam", "steampowered"], platform: "Steam", category: "gaming" },
  { keys: ["epicgames"], platform: "Epic Games", category: "gaming" },
  { keys: ["mi.com", "xiaomi"], platform: "小米", category: "shopping" },
  { keys: ["huawei"], platform: "华为", category: "shopping" },
  { keys: ["12306"], platform: "铁路12306", category: "other" },
  { keys: ["meituan"], platform: "美团", category: "shopping" },
  { keys: ["ele.me", "eleme"], platform: "饿了么", category: "shopping" },
  { keys: ["didi", "xiaojukeji"], platform: "滴滴", category: "other" },
  { keys: ["amazon"], platform: "Amazon", category: "shopping" },
  { keys: ["facebook", "meta.com"], platform: "Facebook", category: "social" },
  { keys: ["instagram"], platform: "Instagram", category: "social" },
  { keys: ["twitter", "x.com"], platform: "X", category: "social" },
  { keys: ["telegram"], platform: "Telegram", category: "social" },
  { keys: ["discord"], platform: "Discord", category: "social" },
  { keys: ["notion"], platform: "Notion", category: "work" },
  { keys: ["figma"], platform: "Figma", category: "work" },
  { keys: ["adobe"], platform: "Adobe", category: "subscription" },
  { keys: ["yuque"], platform: "语雀", category: "work" },
  { keys: ["feishu", "larksuite"], platform: "飞书", category: "work" },
  { keys: ["dingtalk"], platform: "钉钉", category: "work" },
  { keys: ["wps"], platform: "WPS", category: "work" },
  { keys: ["baidu"], platform: "百度", category: "other" },
  { keys: ["iqiyi"], platform: "爱奇艺", category: "subscription" },
  { keys: ["youku"], platform: "优酷", category: "subscription" },
  { keys: ["mgtv"], platform: "芒果TV", category: "subscription" },
  { keys: ["music.163", "netease"], platform: "网易云音乐", category: "subscription" },
];

/** 从 URL 里猜出平台名与分类。猜不出返回空。 */
export function platformFromUrl(url) {
  const s = stripped(url).toLowerCase();
  if (!s) return null;
  let host = s;
  try {
    host = new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    host = s.replace(/^[a-z]+:\/\//, "").split("/")[0];
  }
  host = host.replace(/^www\./, "");
  // 取「最长命中」而不是第一个命中：music.163.com 同时匹配 163.com（网易邮箱）
  // 和 music.163（网易云音乐），先到先得会给出错误答案。
  let hit = null;
  for (const hint of DOMAIN_HINTS) {
    for (const k of hint.keys) {
      if ((host.includes(k) || s.includes(k)) && (!hit || k.length > hit.key.length)) {
        hit = { key: k, platform: hint.platform, category: hint.category };
      }
    }
  }
  if (hit) return { platform: hit.platform, category: hit.category };
  // 兜底：取域名主体，首字母大写。至少比「未命名」有用。
  const parts = host.split(".");
  const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  if (!core || core.length < 2 || /^\d+$/.test(core)) return null;
  return { platform: core.charAt(0).toUpperCase() + core.slice(1), category: "other" };
}

/* ==================== 六、模块判定 ==================== */

function keysOf(obj) {
  return Object.keys(obj || {}).map(normKey);
}

function hasField(keys, module, canonical, minLen = 0) {
  const idx = ALIAS_INDEX[module];
  const targets = new Set();
  for (const [alias, hit] of idx) if (hit.canonical === canonical && alias.length >= minLen) targets.add(alias);
  return keys.some((k) => {
    if (!k) return false;
    if (targets.has(k)) return true;
    for (const t of targets) {
      if (t.length < 2) continue;
      if (k.includes(t)) return true;
      // 反向匹配（别名比列名长）只在列名够长时才允许。
      // 否则「内容」会被「密码内容」这种长别名吞掉 —— 一张工时表会被判成账号数据。
      if (k.length >= 3 && t.includes(k)) return true;
    }
    return false;
  });
}

/**
 * 判断这份数据属于哪个模块。
 * 只看键名特征，不做字段映射 —— 先定模块，再用该模块的别名表精确映射，
 * 否则「说明」这种通用词会在「商户」和「备注」之间反复横跳。
 */
export function guessModule(obj, rawText = "") {
  const keys = keysOf(obj);
  const scores = { account: 0, ledger: 0, hours: 0, media: 0 };

  if (hasField(keys, "account", "password")) scores.account += 6;
  if (hasField(keys, "account", "totp_secret")) scores.account += 3;
  if (hasField(keys, "account", "url")) scores.account += 2;
  if (hasField(keys, "account", "username")) scores.account += 2;
  if (hasField(keys, "account", "platform")) scores.account += 1;

  if (hasField(keys, "ledger", "amount")) scores.ledger += 5;
  if (hasField(keys, "ledger", "direction")) scores.ledger += 3;
  if (hasField(keys, "ledger", "method")) scores.ledger += 2;
  if (hasField(keys, "ledger", "paid_at")) scores.ledger += 2;
  if (hasField(keys, "ledger", "merchant")) scores.ledger += 2;

  if (hasField(keys, "hours", "minutes")) scores.hours += 4;
  if (hasField(keys, "hours", "hours")) scores.hours += 4;
  if (hasField(keys, "hours", "project")) scores.hours += 3;
  if (hasField(keys, "hours", "mood")) scores.hours += 2;

  if (hasField(keys, "media", "rating")) scores.media += 3;
  if (hasField(keys, "media", "watched_on")) scores.media += 2;
  if (hasField(keys, "media", "director")) scores.media += 3;
  if (hasField(keys, "media", "kind")) scores.media += 1;
  if (hasField(keys, "media", "review")) scores.media += 2;
  if (hasField(keys, "media", "title")) scores.media += 1;

  const top = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = top[0];
  const [, second] = top[1];

  // 工时容易和记账撞车（都有「日期/时长/金额」），用原文里的字眼补一刀
  if (/工时|耗时|项目|任务|心情|pomodoro|番茄钟/.test(rawText)) scores.hours += 2;
  if (/账单|交易|支付|消费|营收|支出|收入/.test(rawText)) scores.ledger += 2;
  if (/看过|观影|影评|剧集|电影|追剧/.test(rawText)) scores.media += 1;
  if (/密码|账号|账号本子|password/.test(rawText)) scores.account += 1;

  if (bestScore <= 0) return { module: "", confidence: 0, scores };

  // 两个模块咬得很近时，标记为不确定，界面上让用户确认
  const margin = bestScore - second;
  const confidence = Math.min(0.98, 0.45 + bestScore * 0.06 + margin * 0.08);
  return {
    module: best,
    confidence: Math.round(confidence * 100) / 100,
    ambiguous: margin <= 1,
    scores,
  };
}

/* ==================== 七、来源识别 ==================== */

/**
 * 具名来源识别。只用来告诉用户「我认出来这是什么」，
 * 不影响解析方式 —— 解析永远走字段归一那套。
 */
const SOURCE_HINTS = [
  {
    id: "lifebook-share", label: "LifeBook 分享包", module: "account",
    test: (t) => /"format"\s*:\s*"lifebook-share"|lifebook-share/.test(t),
    hint: "需要对方的分享口令才能打开",
  },
  {
    id: "wechat", label: "微信支付账单", module: "ledger",
    test: (t) => /微信支付账单|微信昵称/.test(t),
  },
  {
    id: "alipay", label: "支付宝账单", module: "ledger",
    test: (t) => /支付宝|电子客户回单|alipay/i.test(t),
  },
  {
    id: "bitwarden", label: "Bitwarden / Vaultwarden", module: "account",
    test: (t) => /"login"\s*:/.test(t) && /"items"\s*:/.test(t),
  },
  {
    id: "accountbook", label: "账号本子 / XYKEY 等账号管理 App", module: "account",
    // 国产账号 App 的导出基本都带中文字段名（标题/账号/密码/分组），
    // 用这个特征和英文系的密码管理器区分开
    test: (t, keys) =>
      /账号本子|xykey|AccountBackup|账号管理/i.test(t) ||
      (keys.includes("password") && keys.some((k) => /[\u4e00-\u9fa5]/.test(k))),
  },
  {
    id: "chrome", label: "浏览器密码导出（Chrome / Edge / Brave）", module: "account",
    test: (t, keys) =>
      keys.includes("name") && keys.includes("url") && keys.includes("username") && keys.includes("password"),
  },
  {
    id: "1password", label: "1Password", module: "account",
    test: (t, keys) => keys.includes("title") && keys.includes("password") && keys.includes("otpauth"),
  },
  {
    id: "lastpass", label: "LastPass", module: "account",
    test: (t, keys) => keys.includes("url") && keys.includes("extra") && keys.includes("grouping"),
  },
  {
    id: "apple-passwords", label: "Apple 密码", module: "account",
    test: (t, keys) =>
      keys.includes("title") && keys.includes("url") && keys.includes("username") &&
      keys.includes("password") && keys.includes("notes"),
  },
  {
    id: "keepass", label: "KeePass / KeePassXC", module: "account",
    test: (t, keys) =>
      keys.includes("password") && keys.includes("title") &&
      (keys.includes("grouping") || keys.includes("notes")) &&
      !keys.some((k) => /[\u4e00-\u9fa5]/.test(k)),
  },
  {
    id: "douban", label: "豆瓣", module: "media",
    test: (t) => /豆瓣|douban/i.test(t),
  },
  {
    id: "imdb", label: "IMDb", module: "media",
    test: (t, keys) => keys.includes("const") || /imdb/i.test(t) || keys.includes("titletype"),
  },
  {
    id: "trakt", label: "Trakt", module: "media",
    test: (t) => /trakt/i.test(t),
  },
  {
    id: "icost", label: "iCost 记账", module: "ledger",
    test: (t) => /icost/i.test(t),
  },
  {
    id: "generic-csv", label: "表格文件（CSV / TSV）", module: "",
    test: () => true,
  },
];

/** 给用户看的「支持导入哪些来源」清单。 */
export const IMPORT_SOURCES = [
  { label: "账号本子 / XYKEY 等账号管理 App", what: "导出为明文文本（JSON）、CSV，或直接复制分享的那段文本", module: "account" },
  { label: "Chrome / Edge / Brave 密码", what: "设置里「导出密码」得到的 CSV", module: "account" },
  { label: "Bitwarden / Vaultwarden", what: "导出 .json 或 .csv", module: "account" },
  { label: "1Password / LastPass / KeePass / Apple 密码", what: "各自导出的 CSV", module: "account" },
  { label: "LifeBook 分享包", what: "别人分享给你的加密文本 + 口令", module: "account" },
  { label: "微信支付账单", what: "微信 → 账单 → 下载账单", module: "ledger" },
  { label: "支付宝账单", what: "支付宝 → 账单 → 开具交易流水证明 / 导出", module: "ledger" },
  { label: "iCost / 随手记 / 钱迹等记账 App", what: "导出 CSV", module: "ledger" },
  { label: "豆瓣", what: "网页版「我看过的影视」导出，或手动整理的表格", module: "media" },
  { label: "IMDb / Trakt", what: "导出的 CSV / JSON", module: "media" },
  { label: "任意工时记录", what: "带 日期 / 项目 / 时长 的表格", module: "hours" },
];

function detectSource(text, keys, module) {
  for (const hint of SOURCE_HINTS) {
    if (hint.module && module && hint.module !== module) continue;
    try {
      if (hint.test(text, keys)) return hint;
    } catch {
      /* 单条规则出错不影响整体识别 */
    }
  }
  return null;
}

/* ==================== 八、三路抽取 ==================== */

/** 找出真正的表头行：账单文件前面常有一堆说明行。 */
function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 30);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < limit; i += 1) {
    const row = rows[i];
    if (!row || row.length < 2) continue;
    const hits = row.filter((c) => isKnownFieldName(c)).length;
    const ratio = hits / row.length;
    if (hits >= 2 && ratio >= 0.4 && hits > bestScore) {
      best = i;
      bestScore = hits;
    }
  }
  return best;
}

function rowsToObjects(rows, headerIndex) {
  const header = rows[headerIndex].map((c, i) => c || `col${i}`);
  const out = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row.some((c) => c !== "")) continue;
    const obj = {};
    // 列名重复时加后缀，避免后面的列覆盖前面的
    header.forEach((key, j) => {
      let k = key;
      let n = 2;
      while (k in obj) {
        k = `${key}_${n}`;
        n += 1;
      }
      obj[k] = row[j] ?? "";
    });
    obj.__row = i + 1;
    out.push(obj);
  }
  return out;
}

/** 从任意 JSON 结构里，递归找出「像记录」的对象数组。 */
export function extractJsonRecords(data, depth = 0) {
  if (data == null || depth > 6) return [];
  if (Array.isArray(data)) {
    // 数组里如果大部分元素是对象，就当成记录表
    const objs = data.filter((x) => x && typeof x === "object" && !Array.isArray(x));
    if (objs.length >= Math.max(1, data.length * 0.6)) {
      const flat = [];
      for (const o of objs) flat.push(flattenOne(o));
      if (flat.some((o) => Object.keys(o).length >= 2)) return flat;
    }
    return data.flatMap((x) => extractJsonRecords(x, depth + 1));
  }
  if (typeof data === "object") {
    // 先看常见的容器键
    for (const key of ["items", "list", "data", "records", "entries", "accounts", "results", "rows", "nodes", "children"]) {
      if (Array.isArray(data[key])) {
        const found = extractJsonRecords(data[key], depth + 1);
        if (found.length) return found;
      }
    }
    for (const v of Object.values(data)) {
      const found = extractJsonRecords(v, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

/**
 * 把嵌套对象压平：Bitwarden 的密码在 login.password 里，
 * 账号本子可能也有自己的嵌套。压平后才能走同一套字段归一。
 * 同时把父级的 title/name 等属性带下来，避免子对象里没有可辨识的名字。
 */
function flattenOne(obj, carry = {}) {
  const flat = { ...carry };
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const inherited = {};
      for (const nameKey of ["name", "title", "platform", "名称", "标题", "平台"]) {
        if (obj[nameKey] && flat[nameKey] === undefined) inherited[nameKey] = obj[nameKey];
      }
      Object.assign(flat, flattenOne(v, { ...flat, ...inherited }));
    } else if (Array.isArray(v)) {
      // uris: [{uri: "..."}] 这类结构取第一个可用地址
      const first = v.find((x) => x && typeof x === "object");
      if (first) Object.assign(flat, flattenOne(first, {}));
      else if (v.length && !(k in flat)) flat[k] = v.join(" ");
    } else if (!(k in flat)) {
      flat[k] = v;
    }
  }
  return flat;
}

/**
 * 从自由文本里抽取记录。
 * 覆盖「账号本子」那种长按复制出来的分享文本，以及手工粘贴的零散内容。
 * 切块 → 块内抽键值对；没有键值对时退化为「一行一条」或「三行一组」。
 */
export function extractTextRecords(text) {
  const s = normalizeText(text).trim();
  if (!s) return [];

  // 先按分隔线 / 空行切块
  const blocks = s
    .split(/\n\s*(?:-{3,}|={3,}|\*{3,}|#{3,}|—{3,})\s*\n|\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const records = [];
  const loose = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    // 先去掉【标题】这种包裹行，它本身就是平台名
    const obj = {};
    let platformFromBracket = "";
    for (const line of lines) {
      const bracket = line.match(/^[【\[「《]\s*(.+?)\s*[】\]」》]\s*[:：]?\s*$/);
      if (bracket) {
        platformFromBracket = bracket[1];
        continue;
      }
      // 「键：值」/「键: 值」/「键=值」/「键 值」（标签与值之间用空格或制表符）
      const kv = line.match(/^([^:：=]{1,20})\s*[:：=]\s*(.*)$/);
      if (kv) {
        const key = kv[1].trim();
        const value = kv[2].trim();
        if (key && value !== undefined) {
          obj[key] = obj[key] === undefined ? value : `${obj[key]} ${value}`;
          continue;
        }
      }
      // 「键<TAB>值」
      const tabbed = line.split(/\t+/);
      if (tabbed.length >= 2) {
        for (let i = 0; i + 1 < tabbed.length; i += 2) {
          if (tabbed[i]) obj[tabbed[i].trim()] = (tabbed[i + 1] || "").trim();
        }
        continue;
      }
      loose.push(line);
    }

    if (platformFromBracket && !obj.platform && !obj["平台"] && !obj["名称"] && !obj["标题"]) {
      obj["平台"] = platformFromBracket;
    }
    if (Object.keys(obj).length >= 2) records.push(obj);
    else if (lines.length === 1) loose.push(lines[0]);
  }

  if (records.length) return records;

  // 没有键值对：看是否像「一行一条」的表格文本
  const allLines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  const tabbedRows = allLines.filter((l) => l.split(/\t+/).length >= 2);
  if (tabbedRows.length >= 2) {
    const rows = tabbedRows.map((l) => l.split(/\t+/));
    const headerIdx = findHeaderRow(rows);
    if (headerIdx >= 0) return rowsToObjects(rows, headerIdx);
  }

  // 再退一步：每行按「平台 账号 密码」这种空格分隔的三段式。
  // 限制每段长度，免得把一整句话拆成「平台/账号」两段。
  const triplets = [];
  for (const line of allLines) {
    const parts = line.split(/\s{2,}|\s*\|\s*|\s*,\s*/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length || parts.some((p) => p.length > 40)) continue;
    if (parts.length >= 3) {
      triplets.push({ "平台": parts[0], "账号": parts[1], "密码": parts.slice(2).join(" ") });
    } else if (parts.length === 2) {
      triplets.push({ "平台": parts[0], "账号": parts[1] });
    }
  }
  if (triplets.length) return triplets;

  // 到这里就认不出来了。
  //
  // 这里曾经有个兜底：把每个非空行当成一条「只有名字的账号」。看着贴心，
  // 实际是灾难 —— 用户随手粘一段聊天记录，就会凭空多出一堆垃圾条目，
  // 而他还得一条条去删。宁可明确说「没认出格式」，也不要往用户库里塞东西。
  return [];
}

/* ==================== 九、标准化 ==================== */

function toAccountRecord(f, raw) {
  const url = stripped(f.url);
  const hinted = platformFromUrl(url);
  let platform = stripped(f.platform) || hinted?.platform || "";
  // 严格模式：只认能精确对上号的分类名，模糊的宁可交给下面的 URL 推断
  let category = accountCategoryKey(f.category, true);
  if (category === "other" && hinted?.category) category = hinted.category;
  if (!platform) platform = stripped(f.username) ? "未命名" : "";
  if (!platform) return null;

  return {
    kind: "account",
    platform,
    category,
    username: stripped(f.username),
    password: stripped(f.password),
    totp_secret: stripped(f.totp_secret),
    url,
    notes: stripped(f.notes),
    tags: parseTags(f.tags),
    is_favorite: /^(1|true|yes|是|y)$/i.test(stripped(f.is_favorite)),
    __row: raw?.__row,
  };
}

function toLedgerRecord(f, raw, warnings) {
  const minor = Math.abs(toMinor(f.amount));
  if (!minor) return null;
  const direction = cleanDirection(f.direction) || "expense";
  const paidAt = cleanDate(f.paid_at) || "";
  const merchant = snip(stripped(f.merchant), 60);
  // 严格模式：来源写的「商户消费」这种分类名靠模糊匹配会归成「购物」，
  // 看着合理其实错。认不出就留空，落库时交给 AI 按商户名判。
  const manualCategory = f.category ? ledgerCategoryKey(f.category, true) : "";

  return {
    kind: "transaction",
    direction,
    amount_minor: minor,
    currency: stripped(f.currency) || "CNY",
    merchant,
    category: manualCategory,
    method: snip(stripped(f.method), 30),
    idea: "",
    feeling: "",
    notes: snip(stripped(f.notes), 200),
    tags: parseTags(f.tags),
    paid_at: paidAt,
    is_subscription: /^(1|true|yes|是)$/i.test(stripped(f.is_subscription)),
    period: stripped(f.period),
    __row: raw?.__row,
    __imported: true,
    __statusTip: stripped(f.status),
  };
}

function toHoursRecord(f, raw) {
  let minutes = 0;
  let unit = "";
  if (stripped(f.minutes)) {
    minutes = toMinutes(f.minutes, "minutes");
    unit = "minutes";
  }
  if (!minutes && stripped(f.hours)) {
    // 列名带「小时」时按小时算；否则看数值大小（<=24 视为小时）
    minutes = toMinutes(f.hours, /小时|hour|^h$/i.test(String(f.hoursUnit || "")) ? "hours" : "");
    unit = "hours";
  }
  if (!minutes && stripped(f.hours)) minutes = toMinutes(f.hours, "");
  if (!minutes || minutes > 1440) return null;

  const day = cleanDate(f.day)?.slice(0, 10) || "";
  const project = snip(stripped(f.project), 40) || "未命名项目";
  let mood = Number(stripped(f.mood).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(mood) || mood < 1 || mood > 5) mood = 3;

  return {
    kind: "session",
    day,
    project,
    minutes,
    mood: Math.round(mood),
    content: snip(stripped(f.content), 500),
    tags: parseTags(f.tags),
    __row: raw?.__row,
    __unitGuess: unit,
  };
}

function toMediaRecord(f, raw, warnings) {
  const title = snip(stripped(f.title), 80);
  if (!title) return null;
  const { value: rating, scaled } = cleanRating(f.rating);
  if (scaled && rating && warnings) warnings.add("评分按 5 分制换算为 10 分制");
  const status = cleanStatus(f.status) || "done";
  return {
    kind: "media",
    // 注意不能叫 kind：kind 已经被用来标记「这条草稿属于哪个模块」，
    // 重名会让影片类型覆盖掉模块标记，记录就变成认不出的东西了。
    media_kind: cleanKind(f.kind, title),
    title,
    status,
    rating,
    review: snip(stripped(f.review), 500),
    thoughts: snip(stripped(f.thoughts), 500),
    director: snip(stripped(f.director), 40),
    year: Number(stripped(f.year).replace(/[^\d]/g, "")) || 0,
    season: Number(stripped(f.season).replace(/[^\d]/g, "")) || 0,
    episode: snip(stripped(f.episode), 20),
    watched_on: status === "done" ? cleanDate(f.watched_on)?.slice(0, 10) || "" : "",
    poster_url: stripped(f.poster_url),
    tags: parseTags(f.tags),
    __row: raw?.__row,
  };
}

function parseTags(value) {
  if (!value) return [];
  const s = stripped(value);
  if (!s || s === "/" || s === "-") return [];
  return s
    .split(/[,，;；、|\s]+/)
    .map((t) => t.replace(/^#/, "").trim())
    .filter((t) => t && t.length <= 16)
    .slice(0, 8);
}

function toRecord(module, fields, raw, warnings) {
  if (module === "account") return toAccountRecord(fields, raw);
  if (module === "ledger") return toLedgerRecord(fields, raw, warnings);
  if (module === "hours") return toHoursRecord(fields, raw);
  if (module === "media") return toMediaRecord(fields, raw, warnings);
  return null;
}

/* ==================== 十、主入口 ==================== */

function shapeOf(text) {
  const s = normalizeText(text).trim();
  if (!s) return "empty";
  if (/^[[{]/.test(s)) {
    try {
      JSON.parse(s);
      return "json";
    } catch {
      /* 不是合法 JSON（可能是 JSON Lines），继续判 */
    }
  }
  const lines = s.split("\n").filter((l) => l.trim());
  if (lines.length >= 2) {
    // 判断依据是「能不能找到表头行」，而不是数前几行有几个逗号。
    // 账单文件前面往往有一大段说明文字（微信账单前 4 行都不是数据），
    // 按比例判会把它误判成自由文本，然后一条都解析不出来。
    const cells = parseDelimited(s, detectDelimiter(s));
    if (findHeaderRow(cells) >= 0) return "table";
  }
  return "text";
}

/**
 * 分析一段导入内容。
 *
 * @param {string} raw 文本（已是字符串；从文件来的请先过 decodeBytes）
 * @param {object} opts
 * @param {string} opts.module 手动指定模块（覆盖自动判断）
 * @param {string} opts.filename 文件名，仅用于展示
 * @returns {{ shape, module, moduleLabel, confidence, source, records, warnings, alternatives, stats }}
 */
export function analyzeInput(raw, opts = {}) {
  const text = normalizeText(raw);
  const warnings = new Set();
  const shape = shapeOf(text);

  if (shape === "empty") {
    return {
      shape, module: "", moduleLabel: "", confidence: 0, source: null,
      records: [], warnings: ["内容为空"], alternatives: [],
      stats: { total: 0, parsed: 0, skipped: 0 },
    };
  }

  // 1. 取出一批「键名随便叫什么」的候选对象
  let rows = [];
  if (shape === "json") {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    rows = data ? extractJsonRecords(data) : [];
    if (!rows.length) warnings.add("没能在 JSON 里找到记录列表，已按文本方式重试");
  }
  if (!rows.length && shape === "table") {
    const delim = detectDelimiter(text);
    const cells = parseDelimited(text, delim);
    const headerIdx = findHeaderRow(cells);
    if (headerIdx >= 0) {
      rows = rowsToObjects(cells, headerIdx);
      if (headerIdx > 0) warnings.add(`已跳过前 ${headerIdx} 行说明文字`);
      if (delim === "\t") warnings.add("识别为制表符分隔");
    }
  }
  if (!rows.length) {
    rows = extractTextRecords(text);
    if (rows.length) warnings.add("按自由文本方式解析，请核对预览");
  }
  if (!rows.length) {
    return {
      shape, module: "", moduleLabel: "", confidence: 0, source: null,
      records: [], warnings: ["没能从内容里认出任何记录"], alternatives: [],
      stats: { total: 0, parsed: 0, skipped: 0 },
    };
  }

  // 2. 定模块：手动指定 > 具名来源 > 字段特征
  const sampleKeys = rows.slice(0, 20).flatMap((r) => Object.keys(r).map(normKey));
  const guess = guessModule(rows[0], text);
  const source = detectSource(text, sampleKeys, opts.module || guess.module);
  let module = opts.module || source?.module || guess.module || "account";
  let confidence = guess.module === module ? guess.confidence : 0.7;
  if (opts.module) confidence = 1;
  if (!MODULES[module]) module = "account";

  // 3. 归一化 + 标准化
  const records = [];
  let skipped = 0;
  for (const row of rows) {
    const fields = canonicalFields(row, module);
    const record = toRecord(module, fields, row, warnings);
    if (record) records.push(record);
    else skipped += 1;
  }
  if (skipped) warnings.add(`${skipped} 行信息不足已跳过（例如金额或名称缺失）`);

  // 4. 其它可能归属，供界面「改判模块」时参考
  const alternatives = Object.entries(guess.scores || {})
    .filter(([m, s]) => s > 0 && m !== module)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([m, s]) => ({ module: m, label: MODULES[m], score: s }));

  if (guess.ambiguous && !opts.module && !source?.module) {
    warnings.add("这份数据同时像两个模块，请确认导入目标");
  }

  // 兜底来源的名字跟着形态走，免得把一段纯文本叫成「表格文件」
  let sourceInfo = null;
  if (source) {
    const fallbackLabel =
      shape === "json" ? "通用 JSON（自动识别字段）"
        : shape === "text" ? "通用文本（自动识别字段）"
          : "表格文件（CSV / TSV）";
    sourceInfo = {
      id: source.id,
      label: source.id === "generic-csv" ? fallbackLabel : source.label,
      hint: source.hint || "",
    };
  }

  return {
    shape,
    module,
    moduleLabel: MODULES[module],
    confidence: Math.round(confidence * 100) / 100,
    source: sourceInfo,
    records,
    warnings: [...warnings],
    alternatives,
    stats: { total: rows.length, parsed: records.length, skipped },
  };
}

/** 把记录转成一句人话，用于预览。密码这类敏感值一律不显示。 */
export function describeRecord(record) {
  const mask = (v) => (v ? "••••••" : "（无）");
  switch (record.kind) {
    case "account":
      return `${record.platform}｜${record.username || "（无账号）"}｜密码${mask(record.password)}`;
    case "transaction": {
      const sign = record.direction === "income" ? "+" : "-";
      return `${(record.paid_at || "无日期").slice(0, 10)}｜${sign}¥${(record.amount_minor / 100).toFixed(2)}｜${record.merchant || "未填写商户"}`;
    }
    case "session":
      return `${record.day || "无日期"}｜${record.project}｜${(record.minutes / 60).toFixed(1)} 小时`;
    case "media": {
      const kindLabel = { tv: "剧集", anime: "动画", doc: "纪录片", movie: "电影" }[record.media_kind] || "电影";
      return `${record.title}｜${kindLabel}${record.rating ? `｜${record.rating} 分` : ""}`;
    }
    default:
      return "（未知类型）";
  }
}

export const KIND_LABELS = {
  account: "账号",
  transaction: "账单",
  session: "工时",
  media: "影视",
};
