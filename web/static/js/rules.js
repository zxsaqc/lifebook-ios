// 本地 AI 打标引擎（零外部依赖、可解释、可持续进化）—— 与后端 rules.py 等价。
//
// 判定链路按置信顺序执行，每条都会留下理由，界面能把「为什么判定成会员订阅」
// 原样展示给用户看；用户一纠正就沉淀成规则，下次自动生效。
//
//   1) 用户纠正过的商户                      → 0.98（权威）
//   2) 订阅词典命中                          → 0.90 + 词内推荐周期
//   3) 历史周期性（同商户金额相近多次出现）  → 0.80
//   4) 关键词归类                            → 0.60
//   5) 金额落在常见会员价位                  → 0.35（弱信号，仅提示）
//   6) 兜底                                  → 0.30

export const SUBSCRIPTION_CATALOG = [
  { keys: ["netflix", "网飞"], label: "Netflix", period: "monthly", category: "entertainment" },
  { keys: ["spotify"], label: "Spotify", period: "monthly", category: "entertainment" },
  { keys: ["disney", "迪士尼"], label: "Disney+", period: "monthly", category: "entertainment" },
  { keys: ["hbo"], label: "HBO", period: "monthly", category: "entertainment" },
  { keys: ["youtube", "premium"], label: "YouTube Premium", period: "monthly", category: "entertainment" },
  { keys: ["apple", "icloud", "app store", "arcade"], label: "Apple 服务", period: "monthly", category: "subscription" },
  { keys: ["adobe", "creative cloud", "photoshop"], label: "Adobe", period: "monthly", category: "subscription" },
  { keys: ["figma"], label: "Figma", period: "monthly", category: "subscription" },
  { keys: ["notion"], label: "Notion", period: "monthly", category: "subscription" },
  { keys: ["github", "copilot"], label: "GitHub Copilot", period: "monthly", category: "subscription" },
  { keys: ["openai", "chatgpt", "gpt"], label: "ChatGPT Plus", period: "monthly", category: "subscription" },
  { keys: ["claude", "anthropic"], label: "Claude Pro", period: "monthly", category: "subscription" },
  { keys: ["midjourney"], label: "Midjourney", period: "monthly", category: "subscription" },
  { keys: ["jetbrains", "intellij", "pycharm"], label: "JetBrains", period: "yearly", category: "subscription" },
  { keys: ["microsoft", "office 365", "m365", "github copilot"], label: "Microsoft 365", period: "yearly", category: "subscription" },
  { keys: ["腾讯视频", "爱奇艺", "优酷", "芒果tv", "哔哩哔哩", "b站大会员"], label: "视频会员", period: "monthly", category: "entertainment" },
  { keys: ["网易云", "qq音乐", "酷狗", "酷我"], label: "音乐会员", period: "monthly", category: "entertainment" },
  { keys: ["京东plus", "京东 plus", "88vip", "天猫会员", "美团会员", "饿了么会员"], label: "电商会员", period: "yearly", category: "shopping" },
  { keys: ["百度网盘", "阿里云盘", "115网盘", "夸克"], label: "网盘会员", period: "monthly", category: "subscription" },
  { keys: ["知乎盐选", "得到", "樊登", "喜马拉雅", "微信读书"], label: "内容会员", period: "monthly", category: "education" },
  { keys: ["阿里云", "腾讯云", "华为云", "vercel", "cloudflare", "aws", "gcp"], label: "云服务", period: "monthly", category: "subscription" },
  { keys: ["服务器", "vps", "域名", "hosting", "虚拟主机"], label: "服务器/域名", period: "monthly", category: "subscription" },
  { keys: ["会员续费", "自动续费", "连续包月", "订阅", "subscri", "membership", "renewal", "recurring"], label: "通用订阅", period: "monthly", category: "subscription" },
];

export const CATEGORY_KEYWORDS = {
  food: ["早餐", "午餐", "晚餐", "外卖", "美团", "饿了么", "星巴克", "瑞幸", "奶茶", "咖啡", "餐厅", "食堂", "food", "cafe", "restaurant", "kfc", "mcdonald", "麦当劳", "肯德基"],
  transport: ["地铁", "公交", "滴滴", "打车", "高铁", "机票", "火车", "加油", "停车", "taxi", "uber", "12306", "中石化"],
  shopping: ["淘宝", "天猫", "京东", "拼多多", "唯品会", "购物", "超市", "便利店", "amazon", "shopee"],
  housing: ["房租", "物业", "水电", "燃气", "宽带", "rent", "电费", "水费"],
  health: ["医院", "挂号", "药", "体检", "医保", "牙医", "hospital", "clinic"],
  education: ["学费", "培训", "课程", "考试", "书", "book", "course", "udemy"],
  entertainment: ["电影", "影院", "演出", "门票", "剧本杀", "ktv", "游戏", "steam", "cinema"],
  social: ["红包", "礼物", "请客", "份子钱", "gift"],
  income: ["工资", "薪水", "奖金", "报销", "salary", "payroll", "退款", "退回"],
};

// 常见会员月付/年付档位（单位：分），命中作为弱信号
export const TYPICAL_PRICES_MINOR = new Set([
  600, 800, 900, 1000, 1200, 1500, 1800, 1900, 2000, 2100, 2400, 2500, 2800, 2900, 3000,
  3300, 3500, 3900, 4500, 4800, 5000, 5800, 6000, 6800, 7800, 8800, 9800, 11800, 12800,
  14800, 16800, 19800, 20800, 22800, 24800, 28800, 29800, 32800, 39800, 49800,
  9900, 99000, 128000, 168000, 199000, 228000, 288000, 365000, 399000, 588000,
]);

export const CATEGORY_LABELS = {
  food: "餐饮", transport: "交通", shopping: "购物", housing: "居住",
  health: "医疗", education: "学习", entertainment: "娱乐", social: "人情",
  subscription: "会员订阅", income: "收入", other: "其他",
};

export const LEDGER_CATEGORIES = Object.keys(CATEGORY_LABELS);

const YEARLY_HINTS = ["年费", "年度", "全年", "annual", "yearly", "12个月", "一年"];
const WEEKLY_HINTS = ["周付", "weekly", "连续包周"];
const QUARTER_HINTS = ["季度", "季付", "quarterly", "3个月"];

/** 归一化商户名：去空白/标点/长数字噪声，便于同商户跨次比对。 */
export function normalizeMerchant(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_/\\|]+/g, "")
    .replace(/\d{4,}/g, "");
}

function detectPeriod(lowered, fallback) {
  if (YEARLY_HINTS.some((h) => lowered.includes(h))) return "yearly";
  if (WEEKLY_HINTS.some((h) => lowered.includes(h))) return "weekly";
  if (QUARTER_HINTS.some((h) => lowered.includes(h))) return "quarterly";
  return fallback;
}

/** 同商户历史里找近似金额的重复扣款（±15% 视为同一档位）。 */
function detectRecurring(history, amountMinor) {
  if (!history || history.length < 2 || amountMinor <= 0) return null;
  const close = history.filter(
    (p) => Math.abs(p.amountMinor - amountMinor) <= Math.max(200, Math.round(amountMinor * 0.15))
  );
  if (close.length >= 2) {
    const avg = close.reduce((s, p) => s + p.amountMinor, 0) / close.length;
    const diff = amountMinor === 0 ? 0 : Math.round((Math.abs(avg - amountMinor) / amountMinor) * 100);
    return { count: close.length, diff };
  }
  return null;
}

/**
 * 给出一条账的自动分类结论（不落库）。
 * @param {object} opts {merchant, amountMinor, learned, history}
 */
export function analyze({ merchant, amountMinor, learned, history }) {
  const text = String(merchant || "").trim();
  const lowered = text.toLowerCase();
  const norm = normalizeMerchant(text);
  const reasons = [];

  // 1) 用户纠正过的规则优先
  if (learned && learned[norm]) {
    const rule = learned[norm];
    const label = CATEGORY_LABELS[rule.category] || rule.category;
    reasons.push(`沿用你上次把「${text}」归类为 ${label}`);
    return finish(rule.category, !!rule.is_subscription, rule.period || "monthly", 0.98, reasons, text);
  }

  // 2) 订阅词典
  for (const item of SUBSCRIPTION_CATALOG) {
    if (item.keys.some((k) => lowered.includes(k))) {
      const period = detectPeriod(lowered, item.period);
      reasons.push(`商户词典命中「${item.label}」，识别为会员/订阅付款`);
      if (period === "yearly") reasons.push("描述中出现年付特征");
      else if (period === "weekly") reasons.push("描述中出现周付特征");
      return finish(item.category, true, period, 0.90, reasons, item.label);
    }
  }

  // 3) 历史周期性
  const recurring = detectRecurring(history, amountMinor);
  if (recurring) {
    reasons.push(`历史上出现过 ${recurring.count} 次相近金额（差异约 ${recurring.diff}%），判定为周期性扣款`);
    return finish("subscription", true, detectPeriod(lowered, "monthly"), 0.80, reasons, text || "周期性扣款");
  }

  // 4) 关键词归类
  for (const [category, keys] of Object.entries(CATEGORY_KEYWORDS)) {
    const hit = keys.find((k) => lowered.includes(k));
    if (hit) {
      reasons.push(`关键词命中「${hit}」`);
      return finish(category, false, "", 0.60, reasons, text);
    }
  }

  // 5) 金额特征（弱信号，只给提示不强行判定）
  if (TYPICAL_PRICES_MINOR.has(amountMinor)) {
    reasons.push(`金额 ${(amountMinor / 100).toFixed(0)} 元落在常见会员价位区间（仅供参考）`);
    return finish("other", false, "", 0.35, reasons, text);
  }

  // 6) 兜底
  if (!text) reasons.push("未填写商户/描述，暂归为其他，可手动选择分类");
  return finish("other", false, "", 0.30, reasons, text);
}

function finish(category, isSubscription, period, confidence, reasons, matchedService) {
  return {
    category,
    category_label: CATEGORY_LABELS[category] || "其他",
    is_subscription: isSubscription,
    period,
    confidence: Math.round(confidence * 100) / 100,
    reasons,
    matched_service: matchedService,
  };
}

/** 把各种周期的订阅折算为「每月成本」，便于统计月度订阅总开销。 */
export function monthlyCost(amountMinor, period) {
  const factor = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
  const f = factor[period || "monthly"];
  return Math.round((amountMinor / 100) * (f === undefined ? 1 : f) * 100) / 100;
}
