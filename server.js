const http = require("http");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
const port = Number(process.env.PORT || 5173);
const db = new DatabaseSync(path.join(root, "portfolio.db"));

const FX = 7.22;
loadLocalEnv();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function loadLocalEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index < 0) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^"|"$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

function quoteProviderConfig() {
  const provider = String(process.env.QUOTE_PROVIDER || "mock").toLowerCase();
  const finnhubKey = process.env.FINNHUB_API_KEY || "";
  const useFinnhub = provider === "finnhub" && Boolean(finnhubKey);
  return {
    provider: useFinnhub ? "finnhub" : "mock",
    providerName: useFinnhub ? "Finnhub + 东方财富" : "东方财富A股 + 模拟美股",
    finnhubKey
  };
}

function deepseekConfig() {
  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  const model = getSetting("deepseekModel", process.env.DEEPSEEK_MODEL || "deepseek-v4-flash");
  const autoIntel = String(process.env.DEEPSEEK_AUTO_INTEL || "false").toLowerCase() === "true";
  return {
    configured: Boolean(apiKey),
    apiKey,
    model,
    autoIntel,
    baseUrl: "https://api.deepseek.com"
  };
}

const seedHoldings = [
  ["A股", "聚光科技", "300203", 200, 18.5, 21.3, "CNY"],
  ["A股", "紫金矿业", "601899", 500, 15.2, 17.8, "CNY"],
  ["A股", "中国平安", "601318", 300, 45.6, 48.3, "CNY"],
  ["美股", "特斯拉", "TSLA", 10, 170, 182.2, "USD"],
  ["美股", "英伟达", "NVDA", 5, 820, 910.35, "USD"]
];

const seedWatchlist = [
  ["特斯拉", "TSLA", 182.2, 1.45, 210],
  ["英伟达", "NVDA", 910.35, 2.12, 980],
  ["贵州茅台", "600519", 1650, -0.6, 1850],
  ["比亚迪", "002594", 248.6, 0.81, 280],
  ["苹果", "AAPL", 189.9, 0.33, 210]
];

const seedNews = [
  ["美联储会议纪要：预计年内降息两次", "20:15"],
  ["英伟达财报超预期，数据中心业务强劲增长", "19:42"],
  ["A股收盘：沪指涨0.42%，创业板指涨0.71%", "15:02"],
  ["比亚迪宣布新车型搭载高阶智驾系统", "14:33"]
];

let intelCache = {
  updatedAt: "",
  news: [],
  flows: { indices: [], sectors: [] },
  risks: []
};

function decodeHtml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market TEXT NOT NULL,
    name TEXT NOT NULL,
    ticker TEXT NOT NULL,
    qty REAL NOT NULL,
    cost REAL NOT NULL,
    price REAL NOT NULL,
    currency TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date TEXT NOT NULL,
    market TEXT NOT NULL,
    ticker TEXT NOT NULL,
    name TEXT NOT NULL,
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    price REAL NOT NULL,
    fee REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL,
    realized_pnl REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_snapshots (
    snapshot_date TEXT PRIMARY KEY,
    total_value REAL NOT NULL,
    market_value REAL NOT NULL,
    cash REAL NOT NULL,
    day_pnl REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    unrealized_pnl REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const count = db.prepare("SELECT COUNT(*) AS count FROM holdings").get().count;
if (count === 0) {
  const insert = db.prepare(`
    INSERT INTO holdings (market, name, ticker, qty, cost, price, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  seedHoldings.forEach((row) => insert.run(...row));
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cash', ?)").run("71904");
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('seed', ?)").run("4");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

function holdings() {
  return db.prepare(`
    SELECT id, market, name, ticker, qty, cost, price, currency, updated_at AS updatedAt
    FROM holdings
    ORDER BY CASE market WHEN 'A股' THEN 0 ELSE 1 END, id
  `).all();
}

function currencyToCny(value, currency) {
  return currency === "USD" ? value * FX : value;
}

function enrichHoldings(rows = holdings()) {
  const previous = getPreviousPrices();
  return rows.map((item) => {
    const marketValueNative = item.qty * item.price;
    const costValueNative = item.qty * item.cost;
    const totalPnlNative = marketValueNative - costValueNative;
    const previousPrice = previous.get(String(item.id)) ?? item.price;
    const dayPnlNative = (item.price - previousPrice) * item.qty;
    const dayBaseValueNative = previousPrice * item.qty;
    const dayPnlRate = ((item.price - previousPrice) / Math.max(previousPrice, 1)) * 100;
    return {
      ...item,
      marketValue: Number(currencyToCny(marketValueNative, item.currency).toFixed(2)),
      marketValueNative: Number(marketValueNative.toFixed(2)),
      dayBaseValue: Number(currencyToCny(dayBaseValueNative, item.currency).toFixed(2)),
      dayBaseValueNative: Number(dayBaseValueNative.toFixed(2)),
      dayPnl: Number(currencyToCny(dayPnlNative, item.currency).toFixed(2)),
      dayPnlNative: Number(dayPnlNative.toFixed(2)),
      dayPnlRate: Number(dayPnlRate.toFixed(2)),
      totalPnl: Number(currencyToCny(totalPnlNative, item.currency).toFixed(2)),
      totalPnlNative: Number(totalPnlNative.toFixed(2)),
      totalPnlRate: Number(((totalPnlNative / Math.max(costValueNative, 1)) * 100).toFixed(2))
    };
  });
}

function groupSummary(rows, market) {
  const items = rows.filter((item) => item.market === market);
  return {
    count: items.length,
    marketValue: Number(items.reduce((sum, item) => sum + item.marketValue, 0).toFixed(2)),
    dayPnl: Number(items.reduce((sum, item) => sum + item.dayPnl, 0).toFixed(2)),
    dayPnlRate: Number(((items.reduce((sum, item) => sum + item.dayPnl, 0) / Math.max(items.reduce((sum, item) => sum + item.dayBaseValue, 0), 1)) * 100).toFixed(2)),
    totalPnl: Number(items.reduce((sum, item) => sum + item.totalPnl, 0).toFixed(2))
  };
}

function getPreviousPrices() {
  const raw = getSetting("dayBasePrices", getSetting("previousPrices", "{}"));
  try {
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

function saveDayBasePrices(rows) {
  const prices = {};
  rows.forEach((item) => {
    const price = Number(item.previousClose ?? item.price);
    if (Number.isFinite(price) && price > 0) prices[String(item.id)] = price;
  });
  setSetting("dayBasePrices", JSON.stringify(prices));
}

function transactions(limit = 100) {
  return db.prepare(`
    SELECT id, trade_date AS tradeDate, market, ticker, name, side, qty, price, fee, currency, realized_pnl AS realizedPnl, created_at AS createdAt
    FROM transactions
    ORDER BY trade_date DESC, id DESC
    LIMIT ?
  `).all(limit);
}

function pnlCalendar() {
  return db.prepare(`
    SELECT snapshot_date AS date, total_value AS totalValue, market_value AS marketValue, cash, day_pnl AS dayPnl,
           realized_pnl AS realizedPnl, unrealized_pnl AS unrealizedPnl
    FROM daily_snapshots
    ORDER BY snapshot_date
  `).all();
}

function formatCnyWan(value) {
  const num = Number(value || 0);
  if (Math.abs(num) >= 100000000) return `${(num / 100000000).toFixed(2)}亿`;
  if (Math.abs(num) >= 10000) return `${(num / 10000).toFixed(2)}万`;
  return `${num.toFixed(0)}`;
}

function formatTimeFromSeconds(seconds) {
  if (!seconds) return "";
  return new Date(Number(seconds) * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).replaceAll("/", "-");
}

async function fetchClsNews(limit = 8) {
  const url = `https://www.cls.cn/nodeapi/telegraphList?app=CailianpressWeb&os=web&refresh_type=1&rn=${limit}&sv=8.4.6`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.cls.cn/telegraph"
      }
    });
    if (!response.ok) throw new Error(`CLS HTTP ${response.status}`);
    const payload = await response.json();
    const rows = payload?.data?.roll_data || [];
    return rows.slice(0, limit).map((item) => ({
      source: "财联社",
      title: item.title || String(item.brief || item.content || "").replace(/^【(.+?)】.*/, "$1").slice(0, 50),
      brief: item.brief || item.content || item.title || "",
      time: formatTimeFromSeconds(item.ctime),
      url: item.shareurl || ""
    })).filter((item) => item.brief || item.title);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRssFeed(source, url, limit = 10, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 YaoH-Investment-Dashboard",
        ...extraHeaders
      }
    });
    if (!response.ok) throw new Error(`${source} HTTP ${response.status}`);
    const xml = await response.text();
    return Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)).slice(0, limit).map((match) => {
      const item = match[0];
      const pick = (tag) => {
        const found = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
        return decodeHtml(found?.[1] || "");
      };
      const pubDate = pick("pubDate");
      const time = pubDate
        ? new Date(pubDate).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replaceAll("/", "-")
        : "";
      return {
        source,
        title: pick("title"),
        brief: pick("description") || pick("title"),
        time,
        url: pick("link")
      };
    }).filter((item) => item.title || item.brief);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYahooHoldingNews(limit = 20) {
  const tickers = holdings()
    .filter((item) => item.currency === "USD")
    .map((item) => item.ticker)
    .filter(Boolean)
    .slice(0, 12);
  if (!tickers.length) return [];
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(tickers.join(","))}&region=US&lang=en-US`;
  return fetchRssFeed("Yahoo Finance", url, limit);
}

async function fetchMultiSourceNews() {
  const results = await Promise.allSettled([
    fetchClsNews(30),
    fetchYahooHoldingNews(20),
    fetchRssFeed("CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html", 12),
    fetchRssFeed("Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml", 8),
    fetchRssFeed("SEC", "https://www.sec.gov/news/pressreleases.rss", 8, { "User-Agent": "Mozilla/5.0 YaoH-Investment-Dashboard contact@example.com" })
  ]);
  const rows = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const seen = new Set();
  return rows.filter((item) => {
    const key = `${item.source}:${item.title}`;
    if (!item.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fallbackRankNews(news) {
  const watchWords = holdings().flatMap((item) => [item.name, item.ticker]).filter(Boolean);
  const sectorWords = ["半导体", "芯片", "AI", "人工智能", "数据中心", "PCB", "英伟达", "美光", "AMD", "纳指", "科技", "有色", "黄金", "电力"];
  return news.map((item) => {
    const text = `${item.title} ${item.brief}`;
    let score = 0;
    watchWords.forEach((word) => { if (word && text.toLowerCase().includes(String(word).toLowerCase())) score += 5; });
    sectorWords.forEach((word) => { if (text.toLowerCase().includes(String(word).toLowerCase())) score += 2; });
    if (["财联社", "Yahoo Finance", "Federal Reserve", "SEC"].includes(item.source)) score += 1;
    return { ...item, relevance: score, reason: score ? "与持仓或关注板块存在关键词关联" : "市场 عمومی资讯" };
  }).sort((a, b) => b.relevance - a.relevance).slice(0, 36);
}

async function rankNewsWithDeepSeek(news, flows) {
  const config = deepseekConfig();
  const fallback = fallbackRankNews(news);
  if (!config.configured || news.length === 0) return fallback;
  const portfolio = holdings().map((item) => ({ market: item.market, name: item.name, ticker: item.ticker }));
  const compact = news.slice(0, 25).map((item, index) => ({
    index,
    source: item.source,
    title: item.title,
    brief: String(item.brief || "").slice(0, 180)
  }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: "你是投资新闻筛选器。基于用户持仓、关注板块和资金流，从新闻中挑出最相关内容。只返回 JSON 数组，不要解释。数组元素格式：{\"index\":数字,\"reason\":\"15字以内理由\",\"relevance\":0到100}"
        },
        {
          role: "user",
          content: JSON.stringify({ portfolio, flows, news: compact }, null, 2)
        }
      ]
    })
  });
  clearTimeout(timeout);
  if (!response.ok) return fallback;
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || "";
  try {
    const json = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
    if (!Array.isArray(json)) return fallback;
    const selected = json
      .filter((item) => Number.isInteger(item.index) && news[item.index])
      .map((item) => ({
        ...news[item.index],
        reason: String(item.reason || "DeepSeek 认为相关"),
        relevance: Number(item.relevance || 0)
      }));
    const selectedKeys = new Set(selected.map((item) => `${item.source}:${item.title}`));
    return [...selected, ...fallback.filter((item) => !selectedKeys.has(`${item.source}:${item.title}`))].slice(0, 36);
  } catch {
    return fallback;
  }
}

async function fetchEastmoneyMarketFlows() {
  const headers = { "User-Agent": "Mozilla/5.0", Referer: "https://data.eastmoney.com/bkzj/" };
  const indexUrl = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f62,f184&secids=1.000001,0.399001,0.399006";
  const sectorUrl = "https://push2.eastmoney.com/api/qt/clist/get?fid=f62&po=1&pz=10&pn=1&np=1&fltt=2&invt=2&fs=m:90+t:2&fields=f12,f14,f2,f3,f62,f184,f66,f69,f72,f75";
  const [indexRes, sectorRes] = await Promise.all([
    fetch(indexUrl, { headers }),
    fetch(sectorUrl, { headers })
  ]);
  if (!indexRes.ok) throw new Error(`Eastmoney index HTTP ${indexRes.status}`);
  if (!sectorRes.ok) throw new Error(`Eastmoney sector HTTP ${sectorRes.status}`);
  const indexPayload = await indexRes.json();
  const sectorPayload = await sectorRes.json();
  const normalize = (row) => ({
    code: row.f12,
    name: row.f14,
    price: Number(row.f2 || 0),
    changePct: Number(row.f3 || 0),
    mainNetInflow: Number(row.f62 || 0),
    mainNetInflowText: formatCnyWan(row.f62),
    mainNetInflowPct: Number(row.f184 || 0),
    superNetInflow: Number(row.f66 || 0),
    largeNetInflow: Number(row.f72 || 0)
  });
  return {
    indices: (indexPayload?.data?.diff || []).map(normalize),
    sectors: (sectorPayload?.data?.diff || []).map(normalize)
  };
}

function fallbackRiskReminders(flows) {
  const indices = flows.indices || [];
  const sectors = flows.sectors || [];
  const outflow = indices.filter((item) => item.mainNetInflow < 0);
  const topSector = sectors[0];
  const risks = [];
  if (outflow.length) {
    risks.push(`主要指数主力资金净流出：${outflow.map((item) => `${item.name}${item.mainNetInflowText}`).join("，")}。`);
  }
  if (topSector) {
    risks.push(`行业资金最强方向：${topSector.name} 主力净流入 ${topSector.mainNetInflowText}，涨跌幅 ${topSector.changePct.toFixed(2)}%。`);
  }
  risks.push("建议结合你的持仓板块暴露观察，不把单日资金流作为独立买卖依据。");
  return risks;
}

async function summarizeRisksWithDeepSeek(news, flows) {
  const config = deepseekConfig();
  if (!config.configured) return fallbackRiskReminders(flows);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      max_tokens: 350,
      messages: [
        {
          role: "system",
          content: "你是谨慎的市场风险监控助手。只基于输入的新闻、指数资金流、板块资金流做中文摘要。输出3条以内，每条一句，避免承诺收益或直接下单建议。"
        },
        {
          role: "user",
          content: JSON.stringify({ news: news.slice(0, 6), flows }, null, 2)
        }
      ]
    })
  });
  clearTimeout(timeout);
  if (!response.ok) return fallbackRiskReminders(flows);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const lines = text.split(/\n+/).map((line) => line.replace(/^[-*\d.、\s]+/, "").trim()).filter(Boolean).slice(0, 3);
  return lines.length ? lines : fallbackRiskReminders(flows);
}

async function marketIntel(force = false) {
  const fresh = intelCache.updatedAt && Date.now() - new Date(intelCache.updatedAt).getTime() < 10 * 60 * 1000;
  if (!force && fresh) return intelCache;
  const config = deepseekConfig();
  const [rawNews, flows] = await Promise.all([
    withTimeout(fetchMultiSourceNews().catch(() => []), 10000, []),
    withTimeout(fetchEastmoneyMarketFlows().catch(() => ({ indices: [], sectors: [] })), 10000, { indices: [], sectors: [] })
  ]);
  const news = config.autoIntel
    ? await withTimeout(rankNewsWithDeepSeek(rawNews, flows).catch(() => fallbackRankNews(rawNews)), 12000, fallbackRankNews(rawNews))
    : fallbackRankNews(rawNews);
  const risks = config.autoIntel
    ? await withTimeout(summarizeRisksWithDeepSeek(news, flows).catch(() => fallbackRiskReminders(flows)), 12000, fallbackRiskReminders(flows))
    : fallbackRiskReminders(flows);
  intelCache = {
    updatedAt: new Date().toISOString(),
    news: news.length ? news : seedNews.map(([title, time]) => ({ source: "示例", title, brief: title, time, url: "", reason: "示例数据", relevance: 0 })),
    flows,
    risks
  };
  return intelCache;
}

function advisorPayload(question = "") {
  const enriched = enrichHoldings();
  const cash = Number(getSetting("cash", "71904"));
  return {
    generatedAt: new Date().toISOString(),
    cash,
    summaries: {
      ashare: groupSummary(enriched, "A股"),
      us: groupSummary(enriched, "美股"),
      total: {
        marketValue: Number(enriched.reduce((sum, item) => sum + item.marketValue, 0).toFixed(2)),
        dayPnl: Number(enriched.reduce((sum, item) => sum + item.dayPnl, 0).toFixed(2)),
        dayPnlRate: Number(((enriched.reduce((sum, item) => sum + item.dayPnl, 0) / Math.max(enriched.reduce((sum, item) => sum + item.dayBaseValue, 0), 1)) * 100).toFixed(2)),
        totalPnl: Number(enriched.reduce((sum, item) => sum + item.totalPnl, 0).toFixed(2))
      }
    },
    holdings: enriched.map((item) => ({
      market: item.market,
      name: item.name,
      ticker: item.ticker,
      qty: item.qty,
      cost: item.cost,
      price: item.price,
      currency: item.currency,
      marketValue: item.marketValue,
      totalPnl: item.totalPnl,
      totalPnlRate: item.totalPnlRate,
      dayPnl: item.dayPnl,
      dayPnlRate: item.dayPnlRate
    })),
    recentTransactions: transactions(20),
    marketIntel: intelCache,
    question: String(question || "").slice(0, 1000)
  };
}

async function callDeepSeekAdvisor(question = "") {
  const config = deepseekConfig();
  if (!config.configured) {
    throw new Error("DeepSeek API key 还没有配置。把 key 给我后，我会写入 .env 并重启服务。");
  }

  const payload = advisorPayload(question);
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.3,
      max_tokens: 900,
      messages: [
        {
          role: "system",
          content: [
            "你是一个谨慎的中文投资分析助手，只基于用户提供的持仓、行情、盈亏和交易记录分析。",
            "不要编造实时新闻，不要承诺收益，不要给出保证性结论。",
            "输出需要短、可执行、结构清晰，包含：组合概览、今日异动、风险点、可观察动作。",
            "交易建议必须用观察/减仓/加仓关注/止损纪律等风险语言表达，不要直接替用户下单。"
          ].join("\n")
        },
        {
          role: "user",
          content: `这是我的投资组合数据，请做投资顾问分析。\n\n${JSON.stringify(payload, null, 2)}`
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek 请求失败：HTTP ${response.status} ${text.slice(0, 180)}`);
  }

  const data = await response.json();
  const answer = data?.choices?.[0]?.message?.content || "";
  if (!answer.trim()) throw new Error("DeepSeek 没有返回有效内容");
  return {
    answer,
    model: data.model || config.model,
    generatedAt: new Date().toISOString(),
    usage: data.usage || null
  };
}

function dashboard() {
  const providerConfig = quoteProviderConfig();
  const advisorConfig = deepseekConfig();
  const enriched = enrichHoldings();
  const cash = Number(getSetting("cash", "71904"));
  const marketValue = enriched.reduce((sum, item) => sum + item.marketValue, 0);
  return {
    cash,
    holdings: enriched,
    summaries: {
      ashare: groupSummary(enriched, "A股"),
      us: groupSummary(enriched, "美股"),
      total: {
        marketValue: Number(marketValue.toFixed(2)),
        dayPnl: Number(enriched.reduce((sum, item) => sum + item.dayPnl, 0).toFixed(2)),
        dayPnlRate: Number(((enriched.reduce((sum, item) => sum + item.dayPnl, 0) / Math.max(enriched.reduce((sum, item) => sum + item.dayBaseValue, 0), 1)) * 100).toFixed(2)),
        totalPnl: Number(enriched.reduce((sum, item) => sum + item.totalPnl, 0).toFixed(2))
      }
    },
    transactions: transactions(),
    pnlCalendar: pnlCalendar(),
    watchlist: seedWatchlist.map(([name, ticker, price, change, target]) => ({ name, ticker, price, change, target })),
    news: seedNews,
    quoteStatus: {
      provider: providerConfig.provider,
      providerName: providerConfig.providerName,
      mode: getSetting("quoteMode", "polling"),
      lastRefreshAt: getSetting("lastQuoteRefreshAt", ""),
      message: getSetting("quoteStatusMessage", "当前使用模拟行情，真实行情源可后续接入")
    },
    advisorStatus: {
      configured: advisorConfig.configured,
      model: advisorConfig.model
    },
    updatedAt: new Date().toISOString()
  };
}

function normalizeHolding(input) {
  const marketInput = String(input.market || "").trim();
  const marketAliases = {
    A: "A股",
    ASHARE: "A股",
    A_SHARE: "A股",
    CN: "A股",
    US: "美股",
    USA: "美股"
  };
  const market = marketAliases[marketInput.toUpperCase()] || marketInput;
  const currency = String(input.currency || (market === "美股" ? "USD" : "CNY")).trim().toUpperCase();
  const holding = {
    market,
    name: String(input.name || "").trim(),
    ticker: String(input.ticker || "").trim().toUpperCase(),
    qty: Number(input.qty),
    cost: Number(input.cost),
    price: Number(input.price || input.cost),
    currency
  };

  if (!["A股", "美股"].includes(holding.market)) throw new Error("市场必须是 A股 或 美股");
  if (!holding.name) throw new Error("名称不能为空");
  if (!holding.ticker) throw new Error("代码不能为空");
  if (!Number.isFinite(holding.qty) || holding.qty <= 0) throw new Error("持仓数量必须大于 0");
  if (!Number.isFinite(holding.cost) || holding.cost <= 0) throw new Error("成本价必须大于 0");
  if (!Number.isFinite(holding.price) || holding.price <= 0) throw new Error("现价必须大于 0");
  if (!["CNY", "USD"].includes(holding.currency)) throw new Error("币种必须是 CNY 或 USD");
  return holding;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("CSV 至少需要表头和一行数据");

  const split = (line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
  const headers = split(lines[0]).map((cell) => cell.toLowerCase());
  const aliases = {
    market: ["market", "市场"],
    name: ["name", "名称", "股票名称"],
    ticker: ["ticker", "code", "代码", "股票代码"],
    qty: ["qty", "quantity", "持仓数量", "数量"],
    cost: ["cost", "average_cost", "成本价"],
    price: ["price", "current_price", "现价"],
    currency: ["currency", "币种"]
  };

  const indexOf = (field) => aliases[field].map((name) => headers.indexOf(name)).find((idx) => idx >= 0);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = split(lines[i]);
    const raw = {};
    Object.keys(aliases).forEach((field) => {
      const idx = indexOf(field);
      if (idx !== undefined) raw[field] = cells[idx];
    });
    rows.push(normalizeHolding(raw));
  }
  return rows;
}

function insertHolding(holding) {
  const stmt = db.prepare(`
    INSERT INTO holdings (market, name, ticker, qty, cost, price, currency, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  const result = stmt.run(holding.market, holding.name, holding.ticker, holding.qty, holding.cost, holding.price, holding.currency);
  return result.lastInsertRowid;
}

function updateHolding(id, holding) {
  const result = db.prepare(`
    UPDATE holdings
    SET market = ?, name = ?, ticker = ?, qty = ?, cost = ?, price = ?, currency = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(holding.market, holding.name, holding.ticker, holding.qty, holding.cost, holding.price, holding.currency, id);
  if (result.changes === 0) throw new Error("没有找到这条持仓");
}

function deleteHolding(id) {
  const result = db.prepare("DELETE FROM holdings WHERE id = ?").run(id);
  if (result.changes === 0) throw new Error("没有找到这条持仓");
}

function replaceHoldings(rows) {
  db.exec("DELETE FROM holdings");
  rows.forEach((row) => insertHolding(normalizeHolding(row)));
}

function normalizeTrade(input) {
  const holding = normalizeHolding({
    market: input.market,
    name: input.name,
    ticker: input.ticker,
    qty: input.qty || 1,
    cost: input.price,
    price: input.price,
    currency: input.currency
  });
  const side = String(input.side || "").trim().toUpperCase();
  if (!["BUY", "SELL", "CLOSE"].includes(side)) throw new Error("交易方向必须是 BUY、SELL 或 CLOSE");
  const trade = {
    tradeDate: String(input.tradeDate || new Date().toISOString().slice(0, 10)).trim(),
    market: holding.market,
    ticker: holding.ticker,
    name: holding.name,
    side,
    qty: Number(input.qty),
    price: Number(input.price),
    fee: Number(input.fee || 0),
    currency: holding.currency
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trade.tradeDate)) throw new Error("交易日期格式必须是 YYYY-MM-DD");
  if (!Number.isFinite(trade.qty) || trade.qty <= 0) throw new Error("交易数量必须大于 0");
  if (!Number.isFinite(trade.price) || trade.price <= 0) throw new Error("成交价必须大于 0");
  if (!Number.isFinite(trade.fee) || trade.fee < 0) throw new Error("手续费不能小于 0");
  return trade;
}

function normalizeTransactionRecord(input, existing = {}) {
  const marketInput = String(input.market || existing.market || "").trim();
  const market = ["US", "USA", "美股"].includes(marketInput.toUpperCase ? marketInput.toUpperCase() : marketInput) || marketInput === "美股" ? "美股" : "A股";
  const currency = String(input.currency || existing.currency || (market === "美股" ? "USD" : "CNY")).trim().toUpperCase();
  const side = String(input.side || existing.side || "").trim().toUpperCase();
  const record = {
    tradeDate: String(input.tradeDate || existing.tradeDate || new Date().toISOString().slice(0, 10)).trim(),
    market,
    ticker: String(input.ticker || existing.ticker || "").trim().toUpperCase(),
    name: String(input.name || existing.name || "").trim(),
    side,
    qty: Number(input.qty ?? existing.qty),
    price: Number(input.price ?? existing.price),
    fee: Number(input.fee ?? existing.fee ?? 0),
    currency,
    realizedPnl: Number(input.realizedPnl ?? existing.realizedPnl ?? 0)
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.tradeDate)) throw new Error("交易日期格式必须是 YYYY-MM-DD");
  if (!["BUY", "SELL", "CLOSE"].includes(record.side)) throw new Error("交易方向必须是 BUY、SELL 或 CLOSE");
  if (!record.name) throw new Error("名称不能为空");
  if (!record.ticker) throw new Error("代码不能为空");
  if (!Number.isFinite(record.qty) || record.qty <= 0) throw new Error("交易数量必须大于 0");
  if (!Number.isFinite(record.price) || record.price <= 0) throw new Error("成交价必须大于 0");
  if (!Number.isFinite(record.fee) || record.fee < 0) throw new Error("手续费不能小于 0");
  if (!Number.isFinite(record.realizedPnl)) throw new Error("实现盈亏必须是数字");
  if (!["CNY", "USD"].includes(record.currency)) throw new Error("币种必须是 CNY 或 USD");
  return record;
}

function transactionById(id) {
  return db.prepare(`
    SELECT id, trade_date AS tradeDate, market, ticker, name, side, qty, price, fee, currency, realized_pnl AS realizedPnl, created_at AS createdAt
    FROM transactions
    WHERE id = ?
  `).get(id);
}

function updateTransaction(id, input) {
  const existing = transactionById(id);
  if (!existing) throw new Error("没有找到这笔交易记录");
  const record = normalizeTransactionRecord(input, existing);
  db.exec("BEGIN");
  try {
    applyTransactionToPortfolio(existing, -1);
    db.prepare(`
      UPDATE transactions
      SET trade_date = ?, market = ?, ticker = ?, name = ?, side = ?, qty = ?, price = ?, fee = ?, currency = ?, realized_pnl = ?
      WHERE id = ?
    `).run(record.tradeDate, record.market, record.ticker, record.name, record.side, record.qty, record.price, record.fee, record.currency, record.realizedPnl, id);
    applyTransactionToPortfolio(record, 1);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  rebuildDailySnapshotForDate(existing.tradeDate);
  rebuildDailySnapshotForDate(record.tradeDate);
}

function deleteTransaction(id) {
  const existing = transactionById(id);
  if (!existing) throw new Error("没有找到这笔交易记录");
  db.exec("BEGIN");
  try {
    applyTransactionToPortfolio(existing, -1);
    db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  rebuildDailySnapshotForDate(existing.tradeDate);
}

function findHoldingByTicker(ticker, market) {
  return db.prepare("SELECT * FROM holdings WHERE ticker = ? AND market = ? ORDER BY id LIMIT 1").get(ticker, market);
}

function upsertHoldingFromTrade(trade, qtyDelta, costBasis) {
  const current = findHoldingByTicker(trade.ticker, trade.market);
  if (!current) {
    if (qtyDelta <= 0) return;
    insertHolding({
      market: trade.market,
      name: trade.name,
      ticker: trade.ticker,
      qty: qtyDelta,
      cost: costBasis,
      price: trade.price,
      currency: trade.currency
    });
    return;
  }

  const newQty = Number(current.qty) + qtyDelta;
  if (newQty <= 0.000001) {
    db.prepare("DELETE FROM holdings WHERE id = ?").run(current.id);
    return;
  }

  let newCost = Number(current.cost);
  if (qtyDelta > 0) {
    newCost = ((Number(current.qty) * Number(current.cost)) + (qtyDelta * costBasis)) / newQty;
  }

  db.prepare("UPDATE holdings SET name = ?, qty = ?, cost = ?, price = ?, currency = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(trade.name, Number(newQty.toFixed(6)), Number(newCost.toFixed(4)), Number(trade.price), trade.currency, current.id);
}

function costFromRealizedPnl(trade) {
  const qty = Math.max(Number(trade.qty || 0), 1);
  const realized = Number(trade.realizedPnl ?? trade.realized_pnl ?? 0);
  const fee = Number(trade.fee || 0);
  const derived = Number(trade.price) - ((realized + fee) / qty);
  return Number.isFinite(derived) && derived > 0 ? derived : Number(trade.price);
}

function applyTransactionToPortfolio(record, direction = 1) {
  const trade = normalizeTransactionRecord(record, record);
  const qty = Number(trade.qty);
  const tradeValue = qty * Number(trade.price);
  const fee = Number(trade.fee || 0);
  let cash = Number(getSetting("cash", "0"));

  if (trade.side === "BUY") {
    if (direction > 0) {
      upsertHoldingFromTrade(trade, qty, Number(trade.price));
      cash -= currencyToCny(tradeValue + fee, trade.currency);
    } else {
      upsertHoldingFromTrade(trade, -qty, Number(trade.price));
      cash += currencyToCny(tradeValue + fee, trade.currency);
    }
  } else if (direction > 0) {
    const current = findHoldingByTicker(trade.ticker, trade.market);
    if (!current) throw new Error("No holding found for this sell transaction");
    if (qty > Number(current.qty) + 0.000001) throw new Error("Sell quantity is greater than current holding");
    upsertHoldingFromTrade(trade, -qty, Number(current.cost));
    cash += currencyToCny(tradeValue - fee, trade.currency);
  } else {
    upsertHoldingFromTrade(trade, qty, costFromRealizedPnl(trade));
    cash -= currencyToCny(tradeValue - fee, trade.currency);
  }

  setSetting("cash", Number(cash.toFixed(2)));
}

function applyTrade(input) {
  const trade = normalizeTrade(input);
  const current = findHoldingByTicker(trade.ticker, trade.market);
  let realizedPnl = 0;
  const tradeValue = trade.qty * trade.price;
  let cash = Number(getSetting("cash", "0"));
  const cashDelta = currencyToCny(tradeValue - trade.fee, trade.currency);

  if (trade.side === "BUY") {
    if (current) {
      const newQty = current.qty + trade.qty;
      const newCost = ((current.qty * current.cost) + tradeValue + trade.fee) / Math.max(newQty, 1);
      db.prepare("UPDATE holdings SET qty = ?, cost = ?, price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(newQty, Number(newCost.toFixed(4)), trade.price, current.id);
    } else {
      insertHolding({ market: trade.market, name: trade.name, ticker: trade.ticker, qty: trade.qty, cost: trade.price, price: trade.price, currency: trade.currency });
    }
    cash -= currencyToCny(tradeValue + trade.fee, trade.currency);
  } else {
    if (!current) throw new Error("卖出前没有找到这只持仓");
    const sellQty = trade.side === "CLOSE" ? current.qty : trade.qty;
    if (sellQty > current.qty) throw new Error("卖出数量不能超过当前持仓");
    realizedPnl = ((trade.price - current.cost) * sellQty) - trade.fee;
    const remainingQty = current.qty - sellQty;
    if (remainingQty <= 0.000001) {
      db.prepare("DELETE FROM holdings WHERE id = ?").run(current.id);
    } else {
      db.prepare("UPDATE holdings SET qty = ?, price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(remainingQty, trade.price, current.id);
    }
    cash += currencyToCny((sellQty * trade.price) - trade.fee, trade.currency);
    trade.qty = sellQty;
  }

  setSetting("cash", Number(cash.toFixed(2)));
  db.prepare(`
    INSERT INTO transactions (trade_date, market, ticker, name, side, qty, price, fee, currency, realized_pnl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(trade.tradeDate, trade.market, trade.ticker, trade.name, trade.side, trade.qty, trade.price, trade.fee, trade.currency, Number(realizedPnl.toFixed(2)));
  recordDailySnapshot(trade.tradeDate, currencyToCny(realizedPnl, trade.currency));
}

function recordDailySnapshot(date = new Date().toISOString().slice(0, 10), realizedPnl = 0) {
  const enriched = enrichHoldings();
  const cash = Number(getSetting("cash", "0"));
  const marketValue = enriched.reduce((sum, item) => sum + item.marketValue, 0);
  const unrealizedPnl = enriched.reduce((sum, item) => sum + item.totalPnl, 0);
  const floatDayPnl = enriched.reduce((sum, item) => sum + item.dayPnl, 0);
  const existing = db.prepare("SELECT realized_pnl AS realizedPnl FROM daily_snapshots WHERE snapshot_date = ?").get(date);
  const realizedTotal = Number(existing?.realizedPnl || 0) + realizedPnl;
  const dayPnl = floatDayPnl + realizedTotal;
  db.prepare(`
    INSERT INTO daily_snapshots (snapshot_date, total_value, market_value, cash, day_pnl, realized_pnl, unrealized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(snapshot_date) DO UPDATE SET
      total_value = excluded.total_value,
      market_value = excluded.market_value,
      cash = excluded.cash,
      day_pnl = excluded.day_pnl,
      realized_pnl = excluded.realized_pnl,
      unrealized_pnl = excluded.unrealized_pnl,
      created_at = CURRENT_TIMESTAMP
  `).run(
    date,
    Number((marketValue + cash).toFixed(2)),
    Number(marketValue.toFixed(2)),
    Number(cash.toFixed(2)),
    Number(dayPnl.toFixed(2)),
    Number(realizedTotal.toFixed(2)),
    Number(unrealizedPnl.toFixed(2))
  );
}

function rebuildDailySnapshotForDate(date) {
  if (!date) return;
  const realized = db.prepare("SELECT COALESCE(SUM(realized_pnl), 0) AS total FROM transactions WHERE trade_date = ?").get(date).total;
  const enriched = enrichHoldings();
  const cash = Number(getSetting("cash", "0"));
  const marketValue = enriched.reduce((sum, item) => sum + item.marketValue, 0);
  const unrealizedPnl = enriched.reduce((sum, item) => sum + item.totalPnl, 0);
  const floatDayPnl = date === new Date().toISOString().slice(0, 10)
    ? enriched.reduce((sum, item) => sum + item.dayPnl, 0)
    : 0;
  const dayPnl = Number(realized || 0) + floatDayPnl;
  db.prepare(`
    INSERT INTO daily_snapshots (snapshot_date, total_value, market_value, cash, day_pnl, realized_pnl, unrealized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(snapshot_date) DO UPDATE SET
      total_value = excluded.total_value,
      market_value = excluded.market_value,
      cash = excluded.cash,
      day_pnl = excluded.day_pnl,
      realized_pnl = excluded.realized_pnl,
      unrealized_pnl = excluded.unrealized_pnl,
      created_at = CURRENT_TIMESTAMP
  `).run(
    date,
    Number((marketValue + cash).toFixed(2)),
    Number(marketValue.toFixed(2)),
    Number(cash.toFixed(2)),
    Number(dayPnl.toFixed(2)),
    Number(Number(realized || 0).toFixed(2)),
    Number(unrealizedPnl.toFixed(2))
  );
}

function simulateNextPrice(item, seed, idx) {
  const move = Math.sin(seed + idx * 2.3) * 0.018 + (idx % 2 ? 0.004 : -0.001);
  return Number(Math.max(item.price * (1 + move), item.cost * 0.55).toFixed(2));
}

async function fetchFinnhubQuote(ticker, token) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Finnhub HTTP ${response.status}`);
    const quote = await response.json();
    const price = Number(quote.c);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Finnhub returned no current price for ${ticker}`);
    const previousClose = Number(quote.pc);
    return {
      price: Number(price.toFixed(2)),
      previousClose: Number.isFinite(previousClose) && previousClose > 0 ? Number(previousClose.toFixed(2)) : Number(price.toFixed(2))
    };
  } finally {
    clearTimeout(timeout);
  }
}

function eastmoneySecid(ticker) {
  const code = String(ticker).trim();
  if (/^(60|68|90)/.test(code)) return `1.${code}`;
  return `0.${code}`;
}

async function fetchEastmoneyQuotes(items) {
  if (items.length === 0) return new Map();
  const secids = items.map((item) => eastmoneySecid(item.ticker)).join(",");
  const fields = "f12,f14,f2,f18";
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=${fields}&secids=${encodeURIComponent(secids)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!response.ok) throw new Error(`Eastmoney HTTP ${response.status}`);
    const payload = await response.json();
    const rows = payload?.data?.diff || [];
    const quotes = new Map();
    rows.forEach((row) => {
      const price = Number(row.f2);
      const previousClose = Number(row.f18);
      if (row.f12 && Number.isFinite(price) && price > 0) {
        quotes.set(String(row.f12), {
          price: Number(price.toFixed(2)),
          previousClose: Number.isFinite(previousClose) && previousClose > 0 ? Number(previousClose.toFixed(2)) : Number(price.toFixed(2))
        });
      }
    });
    return quotes;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshQuotes() {
  const providerConfig = quoteProviderConfig();
  const seed = Number(getSetting("seed", "4")) + 1;
  setSetting("seed", seed);

  const update = db.prepare("UPDATE holdings SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  const currentHoldings = holdings();
  const dayBaseRows = [];
  let usUpdated = 0;
  let cnUpdated = 0;
  let simulated = 0;
  let failed = 0;
  let eastmoneyQuotes = new Map();

  try {
    eastmoneyQuotes = await fetchEastmoneyQuotes(currentHoldings.filter((item) => item.currency === "CNY" && /^\d{6}$/.test(item.ticker)));
  } catch (error) {
    failed += currentHoldings.filter((item) => item.currency === "CNY").length;
  }

  for (const [idx, item] of currentHoldings.entries()) {
    let nextPrice = null;
    let previousClose = null;
    if (providerConfig.provider === "finnhub" && item.currency === "USD") {
      try {
        const quote = await fetchFinnhubQuote(item.ticker, providerConfig.finnhubKey);
        nextPrice = quote.price;
        previousClose = quote.previousClose;
        usUpdated += 1;
      } catch (error) {
        failed += 1;
      }
    }

    if (item.currency === "CNY" && eastmoneyQuotes.has(item.ticker)) {
      const quote = eastmoneyQuotes.get(item.ticker);
      nextPrice = quote.price;
      previousClose = quote.previousClose;
      cnUpdated += 1;
    }

    if (nextPrice === null) {
      nextPrice = simulateNextPrice(item, seed, idx);
      previousClose = item.price;
      simulated += 1;
    }
    update.run(nextPrice, item.id);
    dayBaseRows.push({ id: item.id, price: nextPrice, previousClose });
  }

  saveDayBasePrices(dayBaseRows);
  setSetting("lastQuoteRefreshAt", new Date().toISOString());
  setSetting("quoteMode", "polling");
  setSetting(
    "quoteStatusMessage",
    providerConfig.provider === "finnhub"
      ? `Finnhub US ${usUpdated}; Eastmoney A-share ${cnUpdated}; simulated ${simulated}; failed ${failed}`
      : `Eastmoney A-share ${cnUpdated}; simulated ${simulated}; failed ${failed}`
  );
  recordDailySnapshot();
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(res, 200, dashboard());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/holdings") {
      const input = JSON.parse(await readBody(req));
      const id = insertHolding(normalizeHolding(input));
      sendJson(res, 201, { id, ...dashboard() });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/holdings/replace") {
      const input = JSON.parse(await readBody(req));
      if (!Array.isArray(input.holdings)) throw new Error("holdings 必须是数组");
      replaceHoldings(input.holdings);
      if (input.cash !== undefined) setSetting("cash", Number(input.cash));
      sendJson(res, 200, dashboard());
      return true;
    }

    if (req.method === "DELETE" && url.pathname === "/api/holdings") {
      replaceHoldings([]);
      sendJson(res, 200, dashboard());
      return true;
    }

    const holdingMatch = url.pathname.match(/^\/api\/holdings\/(\d+)$/);
    if (holdingMatch && req.method === "PUT") {
      const input = JSON.parse(await readBody(req));
      updateHolding(Number(holdingMatch[1]), normalizeHolding(input));
      sendJson(res, 200, dashboard());
      return true;
    }

    if (holdingMatch && req.method === "DELETE") {
      deleteHolding(Number(holdingMatch[1]));
      sendJson(res, 200, dashboard());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/import") {
      const text = await readBody(req);
      const rows = parseCsv(text);
      rows.forEach(insertHolding);
      sendJson(res, 201, { imported: rows.length, ...dashboard() });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/transactions") {
      const input = JSON.parse(await readBody(req));
      applyTrade(input);
      sendJson(res, 201, dashboard());
      return true;
    }

    const transactionMatch = url.pathname.match(/^\/api\/transactions\/(\d+)$/);
    if (transactionMatch && req.method === "PUT") {
      const input = JSON.parse(await readBody(req));
      updateTransaction(Number(transactionMatch[1]), input);
      sendJson(res, 200, dashboard());
      return true;
    }

    if (transactionMatch && req.method === "DELETE") {
      deleteTransaction(Number(transactionMatch[1]));
      sendJson(res, 200, dashboard());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      await refreshQuotes();
      sendJson(res, 200, dashboard());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/advisor") {
      const input = JSON.parse(await readBody(req) || "{}");
      sendJson(res, 200, await callDeepSeekAdvisor(input.question || ""));
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/intel") {
      sendJson(res, 200, await marketIntel(url.searchParams.get("force") === "1"));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/advisor/model") {
      const input = JSON.parse(await readBody(req) || "{}");
      const model = String(input.model || "").trim();
      if (!["deepseek-v4-flash", "deepseek-v4-pro"].includes(model)) throw new Error("模型必须是 deepseek-v4-flash 或 deepseek-v4-pro");
      setSetting("deepseekModel", model);
      sendJson(res, 200, { advisorStatus: { configured: deepseekConfig().configured, model } });
      return true;
    }

    return false;
  } catch (error) {
    sendJson(res, 400, { error: error.message || "请求处理失败" });
    return true;
  }
}

function serveStatic(req, res, url) {
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath)] || "text/plain; charset=utf-8" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/") && await handleApi(req, res, url)) return;
  serveStatic(req, res, url);
});

server.listen(port, () => {
  console.log(`Investment dashboard: http://localhost:${port}`);
});
