const FX = 191671.17 / 28442.34;
const HKD_FX = 50175 / 58042.44;
const FILE_MODE = window.location.protocol === "file:";
const STATIC_PAGES_MODE = FILE_MODE || window.location.hostname.endsWith("github.io");
const STORAGE_KEY = "investment-dashboard-local-data";
const AUTO_REFRESH_KEY = "investment-dashboard-auto-refresh";
const defaultDashboard = {
  cash: 71904,
  cashAccounts: {
    ashare: { market: "A股", currency: "CNY", amount: 71904, amountCny: 71904 },
    hk: { market: "港股", currency: "HKD", amount: 0, amountCny: 0 },
    us: { market: "美股", currency: "CNY", amount: 0, amountCny: 0 },
    totalCny: 71904
  },
  holdings: [
    { id: 1, market: "A股", name: "聚光科技", ticker: "300203", qty: 200, cost: 18.5, price: 21.3, currency: "CNY" },
    { id: 2, market: "A股", name: "紫金矿业", ticker: "601899", qty: 500, cost: 15.2, price: 17.8, currency: "CNY" },
    { id: 3, market: "A股", name: "中国平安", ticker: "601318", qty: 300, cost: 45.6, price: 48.3, currency: "CNY" },
    { id: 4, market: "美股", name: "特斯拉", ticker: "TSLA", qty: 10, cost: 170, price: 182.2, currency: "USD" },
    { id: 5, market: "美股", name: "英伟达", ticker: "NVDA", qty: 5, cost: 820, price: 910.35, currency: "USD" }
  ],
  watchlist: [
    { name: "特斯拉", ticker: "TSLA", price: 182.2, change: 1.45, target: 210 },
    { name: "英伟达", ticker: "NVDA", price: 910.35, change: 2.12, target: 980 },
    { name: "贵州茅台", ticker: "600519", price: 1650, change: -0.6, target: 1850 },
    { name: "比亚迪", ticker: "002594", price: 248.6, change: 0.81, target: 280 },
    { name: "苹果", ticker: "AAPL", price: 189.9, change: 0.33, target: 210 }
  ],
  news: [
    ["美联储会议纪要：预计年内降息两次", "20:15"],
    ["英伟达财报超预期，数据中心业务强劲增长", "19:42"],
    ["A股收盘：沪指涨0.42%，创业板指涨0.71%", "15:02"],
    ["比亚迪宣布新车型搭载高阶智驾系统", "14:33"]
  ],
  updatedAt: new Date().toISOString()
};

const state = {
  cash: 0,
  cashAccounts: null,
  cashAdjustments: [],
  holdings: [],
  watchlist: [],
  news: [],
  seed: 4,
  trendRange: 30,
  returnMode: "cumulative",
  watchMode: "all",
  transactions: [],
  pnlCalendar: [],
  summaries: null,
  advisorStatus: null,
  marketFlows: { indices: [], sectors: [] },
  risks: [],
  newsPage: 0,
  newsPageSize: 6,
  pnlView: "curve",
  pnlPeriod: "day",
  quoteStatus: null,
  autoRefresh: {
    enabled: false,
    interval: 60,
    timer: null,
    inFlight: false
  },
  assetHoverIndex: null,
  assetTrendRows: [],
  returnHoverIndex: null,
  returnSeriesRows: [],
  calendarMonth: null
};

function money(value, currency = "CNY") {
  const symbol = currency === "USD" ? "$" : currency === "HKD" ? "HK$" : "¥";
  return `${symbol} ${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function compactMoney(value, currency = "CNY") {
  const symbol = currency === "USD" ? "$" : currency === "HKD" ? "HK$" : "¥";
  return `${symbol}${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tableMoney(value, currency = "CNY") {
  const symbol = currency === "USD" ? "$" : currency === "HKD" ? "HK$" : "¥";
  const number = Math.abs(Number(value));
  const sign = Number(value) < 0 ? "-" : "";
  if (number >= 10000) return `${sign}${symbol}${(number / 10000).toFixed(2)}万`;
  return `${sign}${symbol}${number.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fullDateLabel(date) {
  return String(date || "").replace(/-/g, "/");
}

function signedMoney(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : "-"}${money(Math.abs(number))}`;
}

function signedPercent(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function cnyValue(holding, useCost = false) {
  const price = useCost ? holding.cost : holding.price;
  const raw = holding.qty * price;
  if (holding.currency === "USD") return raw * FX;
  if (holding.currency === "HKD") return raw * HKD_FX;
  return raw;
}

function percent(value) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function classFor(value) {
  return value >= 0 ? "gain" : "loss";
}

function tradeSideText(side) {
  return ({ BUY: "买入", SELL: "卖出", CLOSE: "清仓" })[side] || side;
}

function totals() {
  const invested = state.holdings.reduce((sum, item) => sum + cnyValue(item, true), 0);
  const market = Number(state.summaries?.total?.marketValue ?? state.holdings.reduce((sum, item) => sum + cnyValue(item), 0));
  const total = market + state.cash;
  const pnl = Number(state.summaries?.total?.totalPnl ?? (market - invested));
  const daily = state.holdings.reduce((sum, item) => sum + Number(item.dayPnl || 0), 0);
  const dayBase = state.holdings.reduce((sum, item) => sum + Number(item.dayBaseValue || (cnyValue(item) - Number(item.dayPnl || 0))), 0);
  return { invested, market, total, pnl, daily, dayBase };
}

function currentCashAccounts() {
  const accounts = state.cashAccounts || {};
  const ashare = accounts.ashare || { currency: "CNY", amount: state.cash, amountCny: state.cash };
  const hk = accounts.hk || { currency: "HKD", amount: 0, amountCny: 0 };
  const us = accounts.us || { currency: "CNY", amount: 0, amountCny: 0 };
  const totalCny = Number(accounts.totalCny ?? (Number(ashare.amountCny || 0) + Number(hk.amountCny || 0) + Number(us.amountCny || 0)));
  return {
    ashare: { ...ashare, amount: Number(ashare.amount || 0), amountCny: Number(ashare.amountCny || 0) },
    hk: { ...hk, amount: Number(hk.amount || 0), amountCny: Number(hk.amountCny || 0) },
    us: { ...us, amount: Number(us.amount || 0), amountCny: Number(us.amountCny || 0) },
    totalCny
  };
}

async function api(path, options = {}) {
  if (STATIC_PAGES_MODE) return localApi(path, options);
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function localData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved ? JSON.parse(saved) : structuredClone(defaultDashboard);
}

function saveLocalData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  return data;
}

function normalizeLocalHolding(input) {
  const market = String(input.market || "").trim();
  const currency = String(input.currency || (market === "美股" ? "USD" : market === "港股" ? "HKD" : "CNY")).trim().toUpperCase();
  const holding = {
    market,
    name: String(input.name || "").trim(),
    ticker: String(input.ticker || "").trim().toUpperCase(),
    qty: Number(input.qty),
    cost: Number(input.cost),
    price: Number(input.price || input.cost),
    currency
  };
  if (!["A股", "港股", "美股"].includes(holding.market)) throw new Error("市场必须是 A股、港股 或 美股");
  if (!holding.name) throw new Error("名称不能为空");
  if (!holding.ticker) throw new Error("代码不能为空");
  if (!Number.isFinite(holding.qty) || holding.qty <= 0) throw new Error("持仓数量必须大于 0");
  if (!Number.isFinite(holding.cost) || holding.cost <= 0) throw new Error("成本价必须大于 0");
  if (!Number.isFinite(holding.price) || holding.price <= 0) throw new Error("现价必须大于 0");
  return holding;
}

async function localApi(path, options = {}) {
  const data = localData();
  const method = options.method || "GET";

  if (path === "/api/dashboard" && method === "GET") return data;

  if (path === "/api/holdings" && method === "POST") {
    const input = JSON.parse(options.body || "{}");
    const holding = normalizeLocalHolding(input);
    const id = Math.max(0, ...data.holdings.map((item) => Number(item.id || 0))) + 1;
    data.holdings.push({ id, ...holding, updatedAt: new Date().toISOString() });
    return saveLocalData(data);
  }

  if (path === "/api/holdings/replace" && method === "POST") {
    const input = JSON.parse(options.body || "{}");
    if (!Array.isArray(input.holdings)) throw new Error("holdings 必须是数组");
    data.holdings = input.holdings.map((row, idx) => ({
      id: idx + 1,
      ...normalizeLocalHolding(row),
      updatedAt: new Date().toISOString()
    }));
    if (input.cashAccounts) {
      data.cashAccounts = {
        ashare: { market: "A股", currency: "CNY", amount: Number(input.cashAccounts.ashare || 0), amountCny: Number(input.cashAccounts.ashare || 0) },
        hk: { market: "港股", currency: "HKD", amount: Number(input.cashAccounts.hk || 0), amountCny: Number(input.cashAccounts.hk || 0) * HKD_FX },
        us: { market: "美股", currency: "CNY", amount: Number(input.cashAccounts.us || 0), amountCny: Number(input.cashAccounts.us || 0) }
      };
      data.cashAccounts.totalCny = data.cashAccounts.ashare.amountCny + data.cashAccounts.hk.amountCny + data.cashAccounts.us.amountCny;
      data.cash = data.cashAccounts.totalCny;
    } else if (input.cash !== undefined) {
      data.cash = Number(input.cash);
      data.cashAccounts = {
        ashare: { market: "A股", currency: "CNY", amount: data.cash, amountCny: data.cash },
        hk: { market: "港股", currency: "HKD", amount: 0, amountCny: 0 },
        us: { market: "美股", currency: "CNY", amount: 0, amountCny: 0 },
        totalCny: data.cash
      };
    }
    return saveLocalData(data);
  }

  if (path === "/api/cash" && method === "POST") {
    const input = JSON.parse(options.body || "{}");
    const accounts = data.cashAccounts || {
      ashare: { market: "A股", currency: "CNY", amount: Number(data.cash || 0), amountCny: Number(data.cash || 0) },
      hk: { market: "港股", currency: "HKD", amount: 0, amountCny: 0 },
      us: { market: "美股", currency: "CNY", amount: 0, amountCny: 0 },
      totalCny: Number(data.cash || 0)
    };
    const target = input.market === "US" ? accounts.us : input.market === "HK" ? accounts.hk : accounts.ashare;
    const amount = Number(input.amount);
    if (!Number.isFinite(amount)) throw new Error("资金金额必须是数字");
    target.amount = input.mode === "set" ? amount : Number(target.amount || 0) + amount;
    target.amountCny = target.currency === "HKD" ? target.amount * HKD_FX : target.currency === "USD" ? target.amount * FX : target.amount;
    accounts.totalCny = Number(accounts.ashare.amountCny || 0) + Number(accounts.hk.amountCny || 0) + Number(accounts.us.amountCny || 0);
    data.cashAccounts = accounts;
    data.cash = accounts.totalCny;
    data.cashAdjustments = data.cashAdjustments || [];
    data.cashAdjustments.unshift({
      id: Date.now(),
      adjustmentDate: input.adjustmentDate || new Date().toISOString().slice(0, 10),
      market: input.market === "US" ? "美股" : input.market === "HK" ? "港股" : "A股",
      currency: input.market === "US" ? "CNY" : input.market === "HK" ? "HKD" : "CNY",
      mode: input.mode === "set" ? "set" : "adjust",
      amount,
      balanceAfter: target.amount,
      note: input.note || "补入资金"
    });
    return saveLocalData(data);
  }

  if (path === "/api/holdings" && method === "DELETE") {
    data.holdings = [];
    return saveLocalData(data);
  }

  const holdingMatch = path.match(/^\/api\/holdings\/(\d+)$/);
  if (holdingMatch && method === "PUT") {
    const input = JSON.parse(options.body || "{}");
    const holding = normalizeLocalHolding(input);
    const id = Number(holdingMatch[1]);
    const index = data.holdings.findIndex((item) => Number(item.id) === id);
    if (index < 0) throw new Error("没有找到这条持仓");
    data.holdings[index] = { id, ...holding, updatedAt: new Date().toISOString() };
    return saveLocalData(data);
  }

  if (holdingMatch && method === "DELETE") {
    const id = Number(holdingMatch[1]);
    const before = data.holdings.length;
    data.holdings = data.holdings.filter((item) => Number(item.id) !== id);
    if (data.holdings.length === before) throw new Error("没有找到这条持仓");
    return saveLocalData(data);
  }

  if (path === "/api/refresh" && method === "POST") {
    data.holdings = data.holdings.map((item, idx) => {
      const move = Math.sin(Date.now() / 100000 + idx * 2.3) * 0.018 + (idx % 2 ? 0.004 : -0.001);
      return { ...item, price: Number(Math.max(item.price * (1 + move), item.cost * 0.55).toFixed(2)) };
    });
    data.updatedAt = new Date().toISOString();
    return saveLocalData(data);
  }

  if (path === "/api/import" && method === "POST") {
    const rows = parseLocalCsv(options.body || "");
    const maxId = Math.max(0, ...data.holdings.map((item) => Number(item.id || 0)));
    rows.forEach((row, idx) => data.holdings.push({ id: maxId + idx + 1, ...row, updatedAt: new Date().toISOString() }));
    saveLocalData(data);
    return { ...data, imported: rows.length };
  }

  throw new Error("本地文件模式暂不支持这个操作");
}

function parseLocalCsv(text) {
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
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const raw = {};
    Object.keys(aliases).forEach((field) => {
      const idx = indexOf(field);
      if (idx !== undefined) raw[field] = cells[idx];
    });
    return normalizeLocalHolding(raw);
  });
}

function applyDashboard(data) {
  state.cash = Number(data.cash || 0);
  state.cashAccounts = data.cashAccounts || null;
  state.cashAdjustments = data.cashAdjustments || [];
  state.holdings = (data.holdings || []).map((item) => ({
    ...item,
    qty: Number(item.qty),
    cost: Number(item.cost),
    price: Number(item.price)
  }));
  state.watchlist = data.watchlist || [];
  state.news = data.news || [];
  state.transactions = data.transactions || [];
  state.pnlCalendar = data.pnlCalendar || [];
  state.summaries = data.summaries || null;
  state.advisorStatus = data.advisorStatus || null;
  state.quoteStatus = data.quoteStatus || null;
  state.seed += 1;
}

async function loadDashboard() {
  try {
    applyDashboard(await api("/api/dashboard"));
    loadAutoRefreshSettings();
    updateTime();
    render();
    renderQuoteStatus();
    syncAutoRefreshTimer();
    loadMarketIntel();
    if (STATIC_PAGES_MODE) showToast("当前是 GitHub Pages/静态模式，保存会写入浏览器本地存储");
  } catch (error) {
    showToast(error.message);
  }
}

function updateMetrics() {
  const t = totals();
  const byMarket = (market) => {
    const items = state.holdings.filter((h) => h.market === market);
    const summaryKey = market === "A股" ? "ashare" : market === "港股" ? "hk" : "us";
    const summary = state.summaries?.[summaryKey];
    const marketValue = Number(state.summaries?.[summaryKey]?.marketValue ?? items.reduce((sum, h) => sum + Number(h.marketValue ?? cnyValue(h)), 0));
    const invested = items.reduce((sum, h) => sum + cnyValue(h, true), 0);
    const pnl = Number(summary?.totalPnl ?? items.reduce((sum, h) => sum + Number(h.totalPnl ?? 0), 0));
    const dayPnl = items.reduce((sum, h) => sum + Number(h.dayPnl ?? 0), 0);
    const dayBase = items.reduce((sum, h) => sum + Number(h.dayBaseValue ?? 0), 0);
    return {
      marketValue,
      invested,
      pnl,
      dayPnl,
      totalRate: (pnl / Math.max(invested, 1)) * 100,
      dayRate: (dayPnl / Math.max(dayBase, 1)) * 100
    };
  };
  const ashare = byMarket("A股");
  const hk = byMarket("港股");
  const us = byMarket("美股");
  const dailyRate = state.summaries?.total?.dayPnlRate ?? ((t.daily / Math.max(t.dayBase, 1)) * 100);
  const totalRate = (t.pnl / Math.max(t.invested, 1)) * 100;
  const accounts = currentCashAccounts();
  const cashRate = (accounts.totalCny / Math.max(t.total, 1)) * 100;
  document.getElementById("assetAshareRate").parentElement.firstChild.textContent = "A股现金 ";
  document.getElementById("assetHkRate").parentElement.firstChild.textContent = "港股现金 ";
  document.getElementById("assetUsRate").parentElement.firstChild.textContent = "美股现金 ";
  document.getElementById("cashAccountValue").parentElement.firstChild.textContent = "A股可用 ";
  document.getElementById("availableHkRate").parentElement.firstChild.textContent = "港股可用 ";
  document.getElementById("availableAccountRate").parentElement.firstChild.textContent = "美股可用 ";

  setText("totalAssets", money(t.total));
  setText("dailyRate", percent(dailyRate));
  setText("dailyPnl", `${t.daily >= 0 ? "+" : ""}${money(t.daily)}`);
  setText("todayPnl", `${t.daily >= 0 ? "+" : ""}${money(t.daily)}`);
  setText("todayRate", percent(dailyRate));
  setText("totalPnl", `${t.pnl >= 0 ? "+" : ""}${money(t.pnl)}`);
  setText("totalRate", percent(totalRate));
  setText("cashRate", `${cashRate.toFixed(2)}%`);
  setText("cashValue", money(accounts.totalCny));
  setText("availableCash", money(accounts.totalCny));
  setText("availableRate", "100.00%");
  setText("assetAshare", money(ashare.marketValue));
  setText("assetHk", money(hk.marketValue));
  setText("assetUs", money(us.marketValue));
  setText("todayAshare", `${ashare.dayPnl >= 0 ? "+" : ""}${money(ashare.dayPnl)}`);
  setText("todayHk", `${hk.dayPnl >= 0 ? "+" : ""}${money(hk.dayPnl)}`);
  setText("todayUs", `${us.dayPnl >= 0 ? "+" : ""}${money(us.dayPnl)}`);
  setText("pnlAshare", `${ashare.pnl >= 0 ? "+" : ""}${money(ashare.pnl)}`);
  setText("pnlHk", `${hk.pnl >= 0 ? "+" : ""}${money(hk.pnl)}`);
  setText("pnlUs", `${us.pnl >= 0 ? "+" : ""}${money(us.pnl)}`);
  setText("assetAshareRate", money(accounts.ashare.amount, "CNY"));
  setText("assetHkRate", money(accounts.hk.amount, "HKD"));
  setText("assetUsRate", money(accounts.us.amount, "CNY"));
  setText("cashAccountValue", money(accounts.ashare.amount, "CNY"));
  setText("availableHkRate", money(accounts.hk.amount, "HKD"));
  setText("availableAccountRate", money(accounts.us.amount, "CNY"));
  setText("donutTotal", `¥ ${Math.round(t.total).toLocaleString("zh-CN")}`);

  document.getElementById("todayPnl").className = classFor(t.daily);
  document.getElementById("totalPnl").className = classFor(t.pnl);
  document.getElementById("todayAshare").className = classFor(ashare.dayPnl);
  document.getElementById("todayHk").className = classFor(hk.dayPnl);
  document.getElementById("todayUs").className = classFor(us.dayPnl);
  document.getElementById("pnlAshare").className = classFor(ashare.pnl);
  document.getElementById("pnlHk").className = classFor(hk.pnl);
  document.getElementById("pnlUs").className = classFor(us.pnl);

  const aValue = ashare.marketValue;
  const hValue = hk.marketValue;
  const uValue = us.marketValue;
  setText("asharePct", `${((aValue / Math.max(t.total, 1)) * 100).toFixed(1)}%`);
  setText("hkPct", `${((hValue / Math.max(t.total, 1)) * 100).toFixed(1)}%`);
  setText("usPct", `${((uValue / Math.max(t.total, 1)) * 100).toFixed(1)}%`);
  setText("cashPct", `${((accounts.totalCny / Math.max(t.total, 1)) * 100).toFixed(1)}%`);
  setText("ashareValue", money(aValue));
  setText("hkValue", money(hValue));
  setText("usValue", money(uValue));
  setText("cashLegend", money(accounts.totalCny));

  const cockpitMarkets = [
    { key: "A", market: "A股", summary: ashare, cash: money(accounts.ashare.amount, "CNY") },
    { key: "Hk", market: "港股", summary: hk, cash: money(accounts.hk.amount, "HKD") },
    { key: "Us", market: "美股", summary: us, cash: money(accounts.us.amount, "CNY") }
  ];
  cockpitMarkets.forEach(({ key, market, summary, cash }) => {
    const holdings = state.holdings.filter((item) => item.market === market);
    const top = holdings.reduce((best, item) => {
      const value = Number(item.marketValue ?? cnyValue(item));
      return !best || value > best.value ? { name: item.name, value } : best;
    }, null);
    const magnitude = Math.min(100, Math.max(8, Math.abs(summary.dayRate) * 14 + 24));
    setText(`cockpit${key}Value`, money(summary.marketValue));
    setText(`cockpit${key}Day`, `${summary.dayPnl >= 0 ? "+" : ""}${money(summary.dayPnl)}`);
    setText(`cockpit${key}DayRate`, percent(summary.dayRate));
    setText(`cockpit${key}Cash`, cash);
    setText(`cockpit${key}Count`, `${holdings.length} 只`);
    setText(`cockpit${key}Top`, top?.name || "暂无持仓");
    const day = document.getElementById(`cockpit${key}Day`);
    const rate = document.getElementById(`cockpit${key}DayRate`);
    const bar = document.getElementById(`cockpit${key}Bar`);
    if (day) day.className = classFor(summary.dayPnl);
    if (rate) rate.className = classFor(summary.dayPnl);
    if (bar) {
      bar.style.setProperty("--market-energy", `${magnitude}%`);
      bar.classList.toggle("is-loss", summary.dayPnl < 0);
    }
  });

  const aEnd = (aValue / Math.max(t.total, 1)) * 100;
  const hEnd = aEnd + (hValue / Math.max(t.total, 1)) * 100;
  const uEnd = hEnd + (uValue / Math.max(t.total, 1)) * 100;
  document.getElementById("donut").style.background =
    `conic-gradient(var(--blue) 0 ${aEnd}%, #18c6c8 ${aEnd}% ${hEnd}%, var(--green) ${hEnd}% ${uEnd}%, var(--orange) ${uEnd}% 100%)`;
}

function renderQuoteStatus() {
  const provider = state.quoteStatus?.providerName || "模拟行情";
  const last = state.quoteStatus?.lastRefreshAt ? new Date(state.quoteStatus.lastRefreshAt).toLocaleTimeString("zh-CN", { hour12: false }) : "未刷新";
  setText("quoteProvider", provider);
  setText("quoteLastRefresh", last);
  setText("autoRefreshStatus", state.autoRefresh.enabled ? `${state.autoRefresh.interval}秒自动` : "手动刷新");
}

function renderHoldings() {
  const renderGroup = (market, bodyId, footId, countId) => {
    const group = state.holdings.filter((item) => item.market === market);
    const rows = group.map((item) => {
      const pnl = Number(item.totalPnl ?? (cnyValue(item) - cnyValue(item, true)));
      const dayPnl = Number(item.dayPnl ?? 0);
      const dayRate = Number(item.dayPnlRate ?? 0);
      const rate = Number(item.totalPnlRate ?? ((pnl / Math.max(cnyValue(item, true), 1)) * 100));
      const marketValue = Number(item.marketValue ?? cnyValue(item));
      return `
        <tr>
          <td><span class="holding-name" title="${item.name}">${item.name}</span><small>${item.ticker}</small></td>
          <td>${tableMoney(marketValue)}</td>
          <td>${item.qty}</td>
          <td>${tableMoney(item.cost, item.currency)}</td>
          <td>${tableMoney(item.price, item.currency)}</td>
          <td class="${classFor(pnl)}"><span class="stacked-cell"><b>${pnl >= 0 ? "+" : ""}${tableMoney(pnl)}</b><small>${percent(rate)}</small></span></td>
          <td class="${classFor(dayPnl)}"><span class="stacked-cell"><b>${dayPnl >= 0 ? "+" : ""}${tableMoney(dayPnl)}</b><small>${percent(dayRate)}</small></span></td>
          <td>
            <div class="row-actions">
              <button type="button" data-action="edit" data-id="${item.id}" title="编辑">&#9998;</button>
              <button type="button" data-action="trade" data-id="${item.id}" title="记录交易">⇄</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
    const marketValue = group.reduce((sum, item) => sum + Number(item.marketValue ?? cnyValue(item)), 0);
    const cost = group.reduce((sum, item) => sum + cnyValue(item, true), 0);
    const pnl = group.reduce((sum, item) => sum + Number(item.totalPnl ?? 0), 0);
    const dayPnl = group.reduce((sum, item) => sum + Number(item.dayPnl ?? 0), 0);
    const dayBase = group.reduce((sum, item) => sum + Number(item.dayBaseValue ?? 0), 0);
    const dayRate = (dayPnl / Math.max(dayBase, 1)) * 100;
    const rate = (pnl / Math.max(cost, 1)) * 100;
    document.getElementById(bodyId).innerHTML = rows || `<tr><td colspan="8">暂无持仓</td></tr>`;
    document.getElementById(footId).innerHTML = `
      <tr>
        <td>${market}总计</td>
        <td>${tableMoney(marketValue)}</td>
        <td></td>
        <td></td>
        <td></td>
        <td class="${classFor(pnl)}"><span class="stacked-cell"><b>${pnl >= 0 ? "+" : ""}${tableMoney(pnl)}</b><small>${percent(rate)}</small></span></td>
        <td class="${classFor(dayPnl)}"><span class="stacked-cell"><b>${dayPnl >= 0 ? "+" : ""}${tableMoney(dayPnl)}</b><small>${percent(dayRate)}</small></span></td>
        <td></td>
      </tr>
    `;
    setText(countId, `（${group.length}只）`);
  };
  renderGroup("A股", "aRows", "aFoot", "aCount");
  renderGroup("港股", "hRows", "hFoot", "hCount");
  renderGroup("美股", "uRows", "uFoot", "uCount");
}

function renderWatchlist() {
  const heldTickers = new Set(state.holdings.map((item) => item.ticker));
  const holdingWatchItems = state.holdings.map((item) => ({
    name: item.name,
    ticker: item.ticker,
    price: item.price,
    change: ((item.price - item.cost) / Math.max(item.cost, 1)) * 100,
    target: item.price * 1.12
  }));
  const rows = state.watchMode === "holdings" ? holdingWatchItems : state.watchlist;
  document.getElementById("watchRows").innerHTML = rows.map((item) => `
    <tr>
      <td>${item.name}<small>${item.ticker}</small></td>
      <td>${Number(item.price).toFixed(2)}</td>
      <td class="${classFor(item.change)}">${percent(Number(item.change))}</td>
      <td>${Number(item.target).toFixed(2)}</td>
      <td>${heldTickers.has(item.ticker) ? "★" : "☆"}</td>
    </tr>
  `).join("");
  setText("watchToggleBtn", state.watchMode === "all" ? "持仓 ›" : "全部 ›");
}

function renderNews() {
  const list = document.getElementById("newsList");
  const totalPages = Math.max(Math.ceil(state.news.length / state.newsPageSize), 1);
  state.newsPage = Math.min(state.newsPage, totalPages - 1);
  const pageItems = state.news.slice(state.newsPage * state.newsPageSize, (state.newsPage + 1) * state.newsPageSize);
  list.innerHTML = pageItems.map((item) => {
    const news = Array.isArray(item) ? { title: item[0], time: item[1], source: "资讯" } : item;
    const href = news.url ? ` href="${news.url}" target="_blank" rel="noreferrer"` : "";
    return `
    <li>
      <a${href}><b>${news.title || news.brief}</b><small>${news.reason || ""}</small></a>
      <span>${news.source || "资讯"} · ${news.time || ""}</span>
    </li>
  `;
  }).join("");
  setText("newsPageInfo", `真实新闻 · ${state.news.length || 0}条 · 第${state.newsPage + 1}/${totalPages}页`);
  document.getElementById("newsPrevBtn").disabled = state.newsPage <= 0;
  document.getElementById("newsMoreBtn").disabled = state.newsPage >= totalPages - 1;
}

function renderRisks() {
  const list = document.getElementById("riskList");
  if (!list) return;
  const flowItems = [
    ...(state.marketFlows.indices || []).slice(0, 3).map((item) => `${item.name} 主力${item.mainNetInflow >= 0 ? "净流入" : "净流出"} ${item.mainNetInflowText}，涨跌幅 ${Number(item.changePct).toFixed(2)}%`),
    ...(state.risks || []).slice(0, 3)
  ];
  list.innerHTML = flowItems.map((text) => `
    <li>${text}</li>
  `).join("");
}

function chartTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  return dark
    ? {
        grid: "rgba(214, 255, 244, 0.14)",
        label: "rgba(213, 229, 222, 0.72)",
        line: "#5e9bff",
        fill: "rgba(94, 155, 255, 0.24)",
        fillEnd: "rgba(94, 155, 255, 0)"
      }
    : {
        grid: "rgba(42, 69, 83, 0.12)",
        label: "rgba(64, 82, 73, 0.72)",
        line: "#1a73e8",
        fill: "rgba(26, 115, 232, 0.18)",
        fillEnd: "rgba(26, 115, 232, 0)"
      };
}

function drawLineChart(canvasId, series, lines, formatter, options = {}) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const theme = chartTheme();
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(320, Math.round(rect.width || canvas.clientWidth || canvas.width));
  const cssHeight = Math.max(180, Math.round(rect.height || canvas.clientHeight || 220));
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = cssWidth;
  const height = cssHeight;
  const pad = { top: 26, right: 24, bottom: 38, left: 82 };
  ctx.clearRect(0, 0, width, height);
  ctx.font = "700 12px Microsoft YaHei, PingFang SC, sans-serif";
  ctx.lineWidth = 1;

  const allValues = series.flatMap((s) => s.values);
  const rawMin = Math.min(...allValues, 0);
  const rawMax = Math.max(...allValues, 0);
  const padding = Math.max((rawMax - rawMin) * 0.16, Math.max(Math.abs(rawMax), Math.abs(rawMin), 1) * 0.04);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const range = Math.max(max - min, 1);

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + ((height - pad.top - pad.bottom) / 4) * i;
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    const value = max - (range / 4) * i;
    ctx.fillStyle = theme.label;
    ctx.fillText(formatter(value), 10, y + 4);
  }

  const chartPoints = [];
  series.forEach((item, seriesIndex) => {
    ctx.strokeStyle = item.color || theme.line;
    ctx.lineWidth = item.width || 2;
    ctx.beginPath();
    item.values.forEach((value, idx) => {
      const x = pad.left + ((width - pad.left - pad.right) / Math.max(item.values.length - 1, 1)) * idx;
      const y = pad.top + (1 - (value - min) / range) * (height - pad.top - pad.bottom);
      if (seriesIndex === 0) chartPoints[idx] = { x, y, value };
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (item.fill) {
      const lastX = width - pad.right;
      ctx.lineTo(lastX, height - pad.bottom);
      ctx.lineTo(pad.left, height - pad.bottom);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
      gradient.addColorStop(0, item.fill || theme.fill);
      gradient.addColorStop(1, item.fillEnd || theme.fillEnd);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  });

  if (lines?.length) {
    const candidates = lines
      .map((label, idx) => {
        if (!label) return null;
        const x = pad.left + ((width - pad.left - pad.right) / Math.max(lines.length - 1, 1)) * idx;
        const textWidth = ctx.measureText(label).width;
        const left = Math.max(4, Math.min(x - textWidth / 2, width - textWidth - 4));
        return { label, idx, left, right: left + textWidth };
      })
      .filter(Boolean);
    const visible = [];
    candidates.forEach((candidate, candidateIndex) => {
      const isLast = candidateIndex === candidates.length - 1;
      if (isLast) {
        while (visible.length > 1 && visible[visible.length - 1].right + 14 > candidate.left) visible.pop();
        visible.push(candidate);
        return;
      }
      const previous = visible[visible.length - 1];
      if (!previous || previous.right + 14 <= candidate.left) visible.push(candidate);
    });
    ctx.fillStyle = theme.label;
    visible.forEach(({ label, left }) => ctx.fillText(label, left, height - 8));
  }

  if (options.selectedIndex !== null && options.selectedIndex !== undefined && chartPoints[options.selectedIndex]) {
    const point = chartPoints[options.selectedIndex];
    ctx.save();
    ctx.strokeStyle = "rgba(143, 244, 201, 0.62)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(point.x, pad.top);
    ctx.lineTo(point.x, height - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = theme.line;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  canvas._chartPoints = chartPoints;
  canvas._chartPad = pad;
  canvas._chartCssWidth = width;
  return chartPoints;
}

function makeAssetSeries() {
  const rows = assetTrendRows();
  state.assetTrendRows = rows;
  return rows.map((row) => row.totalValue);
}

function assetTrendRows() {
  const rows = (state.pnlCalendar || [])
    .filter((row) => row.date && Number.isFinite(Number(row.totalValue)))
    .map((row) => ({
      date: row.date,
      totalValue: Number(row.totalValue || 0),
      marketValue: Number(row.marketValue || 0),
      cash: Number(row.cash || 0),
      dayPnl: Number(row.dayPnl || 0)
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!rows.length) {
    const t = totals();
    const today = new Date().toISOString().slice(0, 10);
    return [{
      date: today,
      totalValue: t.total,
      marketValue: t.market,
      cash: state.cash,
      dayPnl: t.daily
    }];
  }

  const lastDate = new Date(`${rows[rows.length - 1].date}T00:00:00`);
  const startDate = new Date(lastDate);
  startDate.setDate(startDate.getDate() - state.trendRange + 1);
  return rows.filter((row) => new Date(`${row.date}T00:00:00`) >= startDate);
}

function assetTrendLabels(rows) {
  if (!rows.length) return [];
  const keep = new Set([0, rows.length - 1]);
  const targetLabels = Math.min(rows.length, window.innerWidth < 760 ? 3 : 5);
  for (let i = 1; i < targetLabels - 1; i += 1) {
    keep.add(Math.round((rows.length - 1) * (i / (targetLabels - 1))));
  }
  return rows.map((row, idx) => keep.has(idx) ? fullDateLabel(row.date) : "");
}

function renderAssetTrendDetail(index = null) {
  const detail = document.getElementById("assetTrendDetail");
  const rows = state.assetTrendRows || [];
  if (!detail || !rows.length) return;
  const safeIndex = index === null || index === undefined ? rows.length - 1 : Math.max(0, Math.min(index, rows.length - 1));
  state.assetHoverIndex = safeIndex;
  const row = rows[safeIndex];
  const previous = rows[safeIndex - 1];
  const change = previous ? row.totalValue - previous.totalValue : 0;
  const changeRate = previous && previous.totalValue ? (change / previous.totalValue) * 100 : 0;
  const tone = change >= 0 ? "gain" : "loss";
  detail.innerHTML = `
    <div>
      <span>选中日期</span>
      <strong>${fullDateLabel(row.date)}</strong>
    </div>
    <div>
      <span>总资产</span>
      <strong>${money(row.totalValue)}</strong>
    </div>
    <div>
      <span>较前记录</span>
      <strong class="${tone}">${signedMoney(change)} · ${signedPercent(changeRate)}</strong>
    </div>
    <div>
      <span>证券市值 / 现金</span>
      <strong>${money(row.marketValue)} / ${money(row.cash)}</strong>
    </div>
  `;
}

function pnlRowsSorted() {
  const transactions = (state.transactions || [])
    .filter((row) => row.tradeDate)
    .slice()
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  let transactionIndex = 0;
  let cumulativeRealizedPnl = 0;
  return (state.pnlCalendar || [])
    .filter((row) => row.date)
    .map((row) => ({
      date: row.date,
      rawDayPnl: Number(row.dayPnl || 0),
      totalValue: Number(row.totalValue || 0),
      marketValue: Number(row.marketValue || 0),
      cash: Number(row.cash || 0),
      realizedPnl: Number(row.realizedPnl || 0),
      unrealizedPnl: Number(row.unrealizedPnl || 0),
      hasData: true
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => {
      while (transactionIndex < transactions.length && transactions[transactionIndex].tradeDate <= row.date) {
        const trade = transactions[transactionIndex];
        const realized = Number(trade.realizedPnl || 0);
        cumulativeRealizedPnl += trade.currency === "USD"
          ? realized * FX
          : trade.currency === "HKD"
            ? realized * HKD_FX
            : realized;
        transactionIndex += 1;
      }
      return {
        ...row,
        cumulativeRealizedPnl,
        cumulativePnl: row.unrealizedPnl + cumulativeRealizedPnl
      };
    });
}

function dateKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function todayKey() {
  return dateKeyOf(new Date());
}

function tradingDayStatus(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  const week = date.getDay();
  const weekend = week === 0 || week === 6;
  const holiday = marketHolidayLabel(dateString);
  return {
    weekend,
    holiday,
    trading: !weekend && !holiday
  };
}

function completedTradingRows(rows = pnlRowsSorted()) {
  if (!rows.length) return [];
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const latest = rows[rows.length - 1];
  const start = new Date(`${rows[0].date}T00:00:00`);
  const end = new Date(`${latest.date}T00:00:00`);
  const result = [];
  let previous = null;
  let previousCumulativePnl = 0;
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const key = dateKeyOf(cursor);
    const status = tradingDayStatus(key);
    if (!status.trading) continue;
    const row = byDate.get(key);
    if (row) {
      const cumulativePnl = Number(row.cumulativePnl || 0);
      const normalized = {
        ...row,
        value: cumulativePnl - previousCumulativePnl
      };
      previous = normalized;
      previousCumulativePnl = cumulativePnl;
      result.push(normalized);
      continue;
    }
    result.push({
      date: key,
      value: 0,
      totalValue: previous?.totalValue ?? latest.totalValue,
      marketValue: previous?.marketValue ?? latest.marketValue,
      cash: previous?.cash ?? latest.cash,
      realizedPnl: previous?.realizedPnl ?? 0,
      unrealizedPnl: previous?.unrealizedPnl ?? latest.unrealizedPnl,
      cumulativeRealizedPnl: previous?.cumulativeRealizedPnl ?? 0,
      cumulativePnl: previousCumulativePnl,
      hasData: false,
      synthetic: true
    });
  }
  return result;
}

function sumPeriodPnl(rows) {
  return rows.reduce(
    (sum, row) => sum + (row.hasData === false ? 0 : Number(row.value || 0)),
    0
  );
}

function pnlSeries() {
  const rows = completedTradingRows();
  if (!rows.length) return [];
  if (state.pnlPeriod === "day") {
    return rows.map((row) => ({
      key: row.date,
      label: fullDateLabel(row.date),
      value: row.value,
      totalValue: row.totalValue,
      marketValue: row.marketValue,
      cash: row.cash,
      hasData: row.hasData !== false
    }));
  }

  if (state.pnlPeriod === "month") {
    const latestYear = Number(rows[rows.length - 1].date.slice(0, 4));
    const grouped = new Map();
    rows.forEach((row) => {
      const year = Number(row.date.slice(0, 4));
      if (year !== latestYear) return;
      const month = Number(row.date.slice(5, 7));
      if (row.hasData === false) return;
      grouped.set(month, (grouped.get(month) || 0) + Number(row.value || 0));
    });
    return Array.from({ length: 12 }, (_, idx) => {
      const month = idx + 1;
      const hasData = grouped.has(month);
      return {
        key: `${latestYear}-${String(month).padStart(2, "0")}`,
        label: `${latestYear}/${String(month).padStart(2, "0")}`,
        value: hasData ? grouped.get(month) : 0,
        hasData
      };
    }).filter((row) => row.hasData);
  }

  const grouped = new Map();
  rows.forEach((row) => {
    const year = row.date.slice(0, 4);
    if (row.hasData === false) return;
    grouped.set(year, (grouped.get(year) || 0) + Number(row.value || 0));
  });
  return Array.from(grouped, ([year, value]) => ({
    key: year,
    label: year,
    value,
    hasData: true
  })).sort((a, b) => a.key.localeCompare(b.key));
}

function pnlAxisLabels(rows) {
  if (!rows.length) return [];
  if (state.pnlPeriod === "month") return rows.map((row) => row.label.slice(5) + "月");
  if (state.pnlPeriod === "year") return rows.map((row) => row.label);
  const keep = new Set([0, rows.length - 1]);
  const count = Math.min(rows.length, window.innerWidth < 760 ? 3 : 6);
  for (let i = 1; i < count - 1; i += 1) {
    keep.add(Math.round((rows.length - 1) * (i / (count - 1))));
  }
  return rows.map((row, idx) => keep.has(idx) ? row.label : "");
}

function renderPnlDetail(index = null) {
  const detail = document.getElementById("pnlDetail");
  const rows = state.returnSeriesRows || [];
  if (!detail || !rows.length) return;
  const safeIndex = index === null || index === undefined ? rows.length - 1 : Math.max(0, Math.min(index, rows.length - 1));
  state.returnHoverIndex = safeIndex;
  const row = rows[safeIndex];
  const previous = rows[safeIndex - 1];
  const change = previous ? row.value - previous.value : 0;
  const rate = previous && Math.abs(previous.value) > 0 ? (change / Math.abs(previous.value)) * 100 : 0;
  detail.innerHTML = `
    <div>
      <span>周期</span>
      <strong>${row.label}</strong>
    </div>
    <div>
      <span>盈亏</span>
      <strong class="${row.value >= 0 ? "gain" : "loss"}">${signedMoney(row.value)}</strong>
    </div>
    <div>
      <span>较前周期</span>
      <strong class="${change >= 0 ? "gain" : "loss"}">${signedMoney(change)} · ${signedPercent(rate)}</strong>
    </div>
    <div>
      <span>数据状态</span>
      <strong>${row.hasData ? "有记录" : "无交易记录"}</strong>
    </div>
  `;
}

function marketHolidayLabel(dateString) {
  const holidays = {
    "2026-01-01": "节假日",
    "2026-02-16": "春节",
    "2026-02-17": "春节",
    "2026-02-18": "春节",
    "2026-04-03": "清明",
    "2026-05-01": "劳动节",
    "2026-06-19": "节假日",
    "2026-10-01": "国庆",
    "2026-10-02": "国庆"
  };
  return holidays[dateString] || "";
}

function selectedCalendarYear(rows) {
  const latestDate = rows.length ? rows[rows.length - 1].date : new Date().toISOString().slice(0, 10);
  const currentMonth = state.calendarMonth || latestDate.slice(0, 7);
  const year = Number(String(currentMonth).slice(0, 4));
  return Number.isFinite(year) ? year : Number(latestDate.slice(0, 4));
}

function periodTone(value) {
  if (value > 0) return "gain-bg";
  if (value < 0) return "loss-bg";
  return "flat-bg";
}

function periodValueText(value, hasData) {
  if (!hasData) return "--";
  const number = Number(value || 0);
  return `${number > 0 ? "+" : ""}${tableMoney(number)}`;
}

function renderCalendarSummary(text, value, hasData = true) {
  const summary = document.getElementById("pnlCalendarSummary");
  if (!summary) return;
  const tone = value > 0 ? "gain" : value < 0 ? "loss" : "";
  summary.innerHTML = `
    <span>${text}</span>
    <strong class="${tone}">${periodValueText(value, hasData)}</strong>
  `;
}

function monthPnlCards(rows, year) {
  const grouped = new Map();
  rows.forEach((row) => {
    if (Number(row.date.slice(0, 4)) !== year) return;
    const month = Number(row.date.slice(5, 7));
    if (row.hasData === false) return;
    grouped.set(month, (grouped.get(month) || 0) + Number(row.value || 0));
  });
  return Array.from({ length: 12 }, (_, idx) => {
    const month = idx + 1;
    const hasData = grouped.has(month);
    return {
      key: `${year}-${String(month).padStart(2, "0")}`,
      label: `${month}月`,
      value: hasData ? grouped.get(month) : 0,
      hasData
    };
  });
}

function yearPnlCards(rows) {
  const grouped = new Map();
  rows.forEach((row) => {
    const year = row.date.slice(0, 4);
    if (row.hasData === false) return;
    grouped.set(year, (grouped.get(year) || 0) + Number(row.value || 0));
  });
  if (!grouped.size) grouped.set(String(new Date().getFullYear()), 0);
  return Array.from(grouped, ([year, value]) => ({
    key: year,
    label: `${year}年`,
    value,
    hasData: rows.some((row) => row.date.startsWith(year))
  })).sort((a, b) => a.key.localeCompare(b.key));
}

function renderPeriodCalendar(rows) {
  const container = document.getElementById("pnlCalendar");
  const title = document.getElementById("pnlCalendarTitle");
  if (!container) return;
  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth() + 1;

  if (state.pnlPeriod === "month") {
    const year = selectedCalendarYear(rows);
    if (title) title.textContent = `${year}年 月收益`;
    const cards = monthPnlCards(rows, year);
    const annual = cards.reduce((sum, row) => sum + (row.hasData ? row.value : 0), 0);
    container.className = "pnl-calendar pnl-period-grid month-grid";
    container.innerHTML = cards.map((row, idx) => {
      const month = idx + 1;
      const future = year > todayYear || (year === todayYear && month > todayMonth);
      const current = year === todayYear && month === todayMonth;
      const cls = [
        "period-card",
        row.hasData && !future ? periodTone(row.value) : "no-record",
        future ? "future-day" : "",
        current ? "today" : ""
      ].filter(Boolean).join(" ");
      const note = future ? "未到月份" : row.hasData ? "月收益" : "无记录";
      return `
        <button class="${cls}" type="button" title="${year}年${month}月 ${note}">
          <b>${row.label}</b>
          <strong>${periodValueText(row.value, row.hasData && !future)}</strong>
          <small>${note}</small>
        </button>
      `;
    }).join("");
    renderCalendarSummary(`${year}年总收益`, annual);
    return;
  }

  if (state.pnlPeriod === "year") {
    if (title) title.textContent = "年度收益";
    const cards = yearPnlCards(rows);
    const total = cards.reduce((sum, row) => sum + (row.hasData ? row.value : 0), 0);
    container.className = "pnl-calendar pnl-period-grid year-grid";
    container.innerHTML = cards.map((row) => {
      const cls = ["period-card", row.hasData ? periodTone(row.value) : "no-record"].join(" ");
      return `
        <button class="${cls}" type="button" title="${row.label} 收益">
          <b>${row.label}</b>
          <strong>${periodValueText(row.value, row.hasData)}</strong>
          <small>${row.hasData ? "年收益" : "无记录"}</small>
        </button>
      `;
    }).join("");
    renderCalendarSummary("累计收益", total);
  }
}

function renderPnlCalendar() {
  const container = document.getElementById("pnlCalendar");
  const title = document.getElementById("pnlCalendarTitle");
  const rows = completedTradingRows();
  if (state.pnlPeriod !== "day") {
    renderPeriodCalendar(rows);
    return;
  }
  const latestDate = rows.length ? rows[rows.length - 1].date : new Date().toISOString().slice(0, 10);
  const currentMonth = state.calendarMonth || latestDate.slice(0, 7);
  state.calendarMonth = currentMonth;
  const [year, month] = currentMonth.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const days = new Date(year, month, 0).getDate();
  const firstWeek = first.getDay();
  const leading = firstWeek === 0 || firstWeek === 6 ? 0 : firstWeek - 1;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const byDate = new Map(rows.map((row) => [row.date, row]));
  if (title) title.textContent = `${year}年${String(month).padStart(2, "0")}月`;
  container.className = "pnl-calendar trading-calendar";

  const cells = [];
  ["周一", "周二", "周三", "周四", "周五"].forEach((label) => {
    cells.push(`<div class="calendar-weekday">${label}</div>`);
  });
  for (let i = 0; i < leading; i += 1) cells.push(`<div class="calendar-empty"></div>`);
  for (let day = 1; day <= days; day += 1) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const row = byDate.get(date);
    const value = row?.value;
    const week = new Date(year, month - 1, day).getDay();
    const weekend = week === 0 || week === 6;
    if (weekend) continue;
    const holiday = marketHolidayLabel(date);
    const future = date > todayKey;
    const cls = [
      row ? periodTone(value) : "",
      weekend ? "non-trading" : "",
      holiday ? "holiday" : "",
      future ? "future-day" : "",
      date === todayKey ? "today" : ""
    ].filter(Boolean).join(" ");
    const note = holiday || (weekend ? "周末休市" : future ? "未到日期" : !row ? "无记录" : row.hasData === false ? "补齐记录" : "交易日");
    const displayValue = holiday ? "休市" : future ? "待更新" : row ? periodValueText(value, true) : "无记录";
    cells.push(`
      <button class="${cls}" title="${fullDateLabel(date)} ${note}">
        <b>${day}</b>
        <span>${displayValue}</span>
        <small>${note}</small>
      </button>
    `);
  }
  container.innerHTML = cells.join("");
  const monthTotal = sumPeriodPnl(rows.filter((row) => row.date.startsWith(currentMonth)));
  renderCalendarSummary(`${year}年${String(month).padStart(2, "0")}月收益`, monthTotal);
}

function renderCharts() {
  const theme = chartTheme();
  const assetValues = makeAssetSeries();
  const trendLabels = assetTrendLabels(state.assetTrendRows);
  const firstTrend = state.assetTrendRows[0];
  const lastTrend = state.assetTrendRows[state.assetTrendRows.length - 1];
  setText(
    "trendDateRange",
    firstTrend && lastTrend
      ? `（${fullDateLabel(firstTrend.date)} - ${fullDateLabel(lastTrend.date)}）`
      : `（近${state.trendRange}天）`
  );
  const selectedIndex = state.assetHoverIndex === null || state.assetHoverIndex >= state.assetTrendRows.length
    ? Math.max(state.assetTrendRows.length - 1, 0)
    : state.assetHoverIndex;
  drawLineChart("assetChart", [{
    values: assetValues,
    color: theme.line,
    fill: theme.fill,
    fillEnd: theme.fillEnd,
    width: 3
  }], trendLabels, (v) => tableMoney(v), { selectedIndex });
  renderAssetTrendDetail(selectedIndex);

  const pnl = pnlSeries();
  state.returnSeriesRows = pnl;
  const chart = document.getElementById("returnChart");
  const calendar = document.getElementById("pnlCalendarShell");
  const detail = document.getElementById("pnlDetail");
  chart.hidden = state.pnlView === "calendar";
  calendar.hidden = state.pnlView !== "calendar";
  if (detail) detail.hidden = state.pnlView === "calendar";
  if (state.pnlView === "calendar") {
    renderPnlCalendar();
  } else if (!pnl.length) {
    const ctx = chart.getContext("2d");
    ctx.clearRect(0, 0, chart.width, chart.height);
    ctx.fillStyle = theme.label;
    ctx.font = "600 14px Microsoft YaHei, PingFang SC, sans-serif";
    ctx.fillText("暂无真实盈亏记录，刷新行情或记录交易后生成", 24, 42);
  } else {
    const selectedReturnIndex = state.returnHoverIndex === null || state.returnHoverIndex >= pnl.length
      ? Math.max(pnl.length - 1, 0)
      : state.returnHoverIndex;
    drawLineChart(
      "returnChart",
      [{ values: pnl.map((row) => row.value), color: theme.line, fill: theme.fill, fillEnd: theme.fillEnd, width: 3 }],
      pnlAxisLabels(pnl),
      (v) => tableMoney(v),
      { selectedIndex: selectedReturnIndex }
    );
    renderPnlDetail(selectedReturnIndex);
  }
}

function updateTime() {
  const text = new Date().toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).replaceAll("/", "-");
  setText("topTime", text);
  setText("sidebarTime", text);
}

async function refreshData() {
  if (state.autoRefresh.inFlight) return;
  state.autoRefresh.inFlight = true;
  try {
    applyDashboard(await api("/api/refresh", { method: "POST" }));
    updateTime();
    render();
    renderQuoteStatus();
    loadMarketIntel(false);
    showToast("行情已刷新，盈亏已重算");
  } catch (error) {
    showToast(error.message);
  } finally {
    state.autoRefresh.inFlight = false;
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 1800);
}

function render() {
  updateMetrics();
  renderHoldings();
  renderWatchlist();
  renderNews();
  renderRisks();
  renderTrades();
  renderAdvisorStatus();
  renderCharts();
}

function renderTrades() {
  const rows = state.transactions || [];
  const body = document.getElementById("tradeRows");
  if (!body) return;
  const realized = rows.reduce((sum, item) => sum + Number(item.realizedPnl || 0), 0);
  setText("tradeSummary", `${rows.length} 笔交易 · 实现盈亏 ${realized >= 0 ? "+" : ""}${money(realized)}`);
  body.innerHTML = rows.length ? rows.map((item) => `
    <tr>
      <td>${item.tradeDate}</td>
      <td><span class="trade-side ${String(item.side).toLowerCase()}">${tradeSideText(item.side)}</span></td>
      <td>${item.name}<small>${item.ticker} · ${item.market}</small></td>
      <td>${Number(item.qty).toLocaleString("zh-CN")}</td>
      <td>${tableMoney(item.price, item.currency)}</td>
      <td>${tableMoney(item.fee || 0, item.currency)}</td>
      <td class="${classFor(Number(item.realizedPnl || 0))}">${Number(item.realizedPnl || 0) >= 0 ? "+" : ""}${tableMoney(item.realizedPnl || 0, item.currency)}</td>
      <td>
        <div class="row-actions">
          <button type="button" data-trade-action="edit" data-id="${item.id}" title="编辑交易">&#9998;</button>
          <button type="button" data-trade-action="delete" data-id="${item.id}" title="删除交易">×</button>
        </div>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="8">暂无交易记录。点击右上角“记录交易”开始记录买入、卖出或清仓。</td></tr>`;
}

function renderAdvisorStatus() {
  const status = document.getElementById("advisorStatus");
  if (!status) return;
  if (state.advisorStatus?.configured) {
    status.textContent = `已连接 ${state.advisorStatus.model || "DeepSeek"}`;
    status.className = "gain";
  } else {
    status.textContent = "等待配置 API Key";
    status.className = "";
  }
  const select = document.getElementById("advisorModelSelect");
  if (select && state.advisorStatus?.model) select.value = state.advisorStatus.model;
}

function formatAdvisorAnswer(text) {
  return String(text || "")
    .replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]))
    .replace(/\n{2,}/g, "\n\n")
    .replace(/\n/g, "<br>");
}

async function askAdvisor() {
  const button = document.getElementById("advisorAskBtn");
  const output = document.getElementById("advisorOutput");
  const question = document.getElementById("advisorQuestion").value.trim();
  button.disabled = true;
  output.innerHTML = "DeepSeek 正在读取你的持仓和行情数据...";
  try {
    const data = await api("/api/advisor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question })
    });
    output.innerHTML = formatAdvisorAnswer(data.answer);
    showToast("投资顾问分析已生成");
  } catch (error) {
    output.textContent = error.message;
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function changeAdvisorModel(event) {
  const model = event.target.value;
  try {
    const data = await api("/api/advisor/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model })
    });
    state.advisorStatus = data.advisorStatus;
    renderAdvisorStatus();
    showToast(model === "deepseek-v4-pro" ? "已切换到 Pro 模型" : "已切换到 Flash 模型");
  } catch (error) {
    showToast(error.message);
  }
}

async function loadMarketIntel(force = false) {
  try {
    const data = await api(`/api/intel${force ? "?force=1" : ""}`);
    state.news = data.news || state.news;
    if (force) state.newsPage = 0;
    state.marketFlows = data.flows || { indices: [], sectors: [] };
    state.risks = data.risks || [];
    renderNews();
    renderRisks();
  } catch (error) {
    showToast(`资讯/资金流读取失败：${error.message}`);
  }
}

function turnNewsPage(delta) {
  const totalPages = Math.max(Math.ceil(state.news.length / state.newsPageSize), 1);
  state.newsPage = Math.max(0, Math.min(totalPages - 1, state.newsPage + delta));
  renderNews();
}

function ensureCashControls() {
  if (!document.getElementById("cashBtn")) {
    const tradeBtn = document.getElementById("tradeBtn");
    tradeBtn?.insertAdjacentHTML("afterend", '<button id="cashBtn" type="button"><span>¥</span>调整资金</button>');
  }
  if (!document.getElementById("cashModalBackdrop")) {
    document.body.insertAdjacentHTML("beforeend", `
      <div id="cashModalBackdrop" class="modal-backdrop" hidden>
        <form id="cashForm" class="modal">
          <div class="panel-title">
            <h3>调整可用资金</h3>
            <button type="button" id="closeCashModal">×</button>
          </div>
          <div class="form-grid">
            <label>账户
              <select name="market">
                <option value="A">A股现金（CNY）</option>
                <option value="HK">港股现金（HKD）</option>
                <option value="US">美股现金（CNH）</option>
              </select>
            </label>
            <label>方式
              <select name="mode">
                <option value="adjust">追加/减少</option>
                <option value="set">直接设置余额</option>
              </select>
            </label>
            <label>金额<input name="amount" type="number" step="0.01" inputmode="decimal" placeholder="请输入补入金额" required /></label>
            <label>当前余额<input name="current" readonly /></label>
            <label>日期<input name="adjustmentDate" type="date" required /></label>
            <label>备注<input name="note" maxlength="120" placeholder="例如：追加投资本金" /></label>
          </div>
          <p id="cashFormHint" class="form-hint">追加资金请输入正数；减少资金请输入负数。</p>
          <div class="modal-actions">
            <button type="button" id="cancelCashModal">取消</button>
            <button type="submit" id="saveCashBtn">保存资金</button>
          </div>
        </form>
      </div>
    `);
  }
}

function syncCashFormCurrent() {
  const form = document.getElementById("cashForm");
  if (!form) return;
  const accounts = currentCashAccounts();
  const isUs = form.elements.market.value === "US";
  const isHk = form.elements.market.value === "HK";
  form.elements.current.value = isUs ? money(accounts.us.amount, "CNY") : isHk ? money(accounts.hk.amount, "HKD") : money(accounts.ashare.amount, "CNY");
}

function openCashModal() {
  ensureCashControls();
  const form = document.getElementById("cashForm");
  form.reset();
  form.elements.mode.value = "adjust";
  form.elements.adjustmentDate.value = new Date().toISOString().slice(0, 10);
  syncCashFormCurrent();
  document.getElementById("cashModalBackdrop").hidden = false;
}

function closeCashModal() {
  document.getElementById("cashModalBackdrop").hidden = true;
  document.getElementById("cashForm").reset();
}

async function submitCash(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const amount = Number(data.amount);
  if (data.amount === "" || !Number.isFinite(amount)) {
    showToast("请输入有效的资金金额");
    event.currentTarget.elements.amount.focus();
    return;
  }
  const button = document.getElementById("saveCashBtn");
  button.disabled = true;
  button.textContent = "保存中...";
  try {
    const result = await api("/api/cash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    applyDashboard(result);
    const accounts = currentCashAccounts();
    const balance = data.market === "US" ? money(accounts.us.amount, "CNY") : data.market === "HK" ? money(accounts.hk.amount, "HKD") : money(accounts.ashare.amount, "CNY");
    closeCashModal();
    render();
    showToast(`可用资金已更新：${balance}`);
  } catch (error) {
    showToast(`保存失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "保存资金";
  }
}

function openModal(holding = null) {
  const form = document.getElementById("holdingForm");
  form.reset();
  const deleteBtn = document.getElementById("deleteHoldingBtn");
  if (holding) {
    form.elements.id.value = holding.id;
    form.elements.market.value = holding.market;
    form.elements.currency.value = holding.currency;
    form.elements.name.value = holding.name;
    form.elements.ticker.value = holding.ticker;
    form.elements.qty.value = holding.qty;
    form.elements.cost.value = holding.cost;
    form.elements.price.value = holding.price;
    setText("holdingModalTitle", "编辑持仓");
    setText("saveHoldingBtn", "保存修改");
    deleteBtn.hidden = false;
  } else {
    form.elements.id.value = "";
    setText("holdingModalTitle", "添加持仓");
    setText("saveHoldingBtn", "保存持仓");
    deleteBtn.hidden = true;
  }
  document.getElementById("modalBackdrop").hidden = false;
}

function closeModal() {
  document.getElementById("modalBackdrop").hidden = true;
  document.getElementById("holdingForm").reset();
}

async function submitHolding(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const id = data.id;
  delete data.id;
  try {
    applyDashboard(await api(id ? `/api/holdings/${id}` : "/api/holdings", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }));
    closeModal();
    render();
    showToast(id ? "持仓已更新" : "持仓已保存");
  } catch (error) {
    showToast(error.message);
  }
}

function openTradeModal(defaults = {}) {
  const form = document.getElementById("tradeForm");
  form.reset();
  form.elements.id.value = defaults.id || "";
  form.elements.tradeDate.value = new Date().toISOString().slice(0, 10);
  Object.entries(defaults).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value;
  });
  setText("tradeModalTitle", defaults.id ? "编辑交易" : "记录交易");
  setText("saveTradeBtn", defaults.id ? "保存修改" : "保存交易");
  document.getElementById("deleteTradeBtn").hidden = !defaults.id;
  document.getElementById("tradeModalBackdrop").hidden = false;
}

function closeTradeModal() {
  document.getElementById("tradeModalBackdrop").hidden = true;
  document.getElementById("tradeForm").reset();
}

async function submitTrade(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const id = data.id;
  delete data.id;
  try {
    applyDashboard(await api(id ? `/api/transactions/${id}` : "/api/transactions", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }));
    closeTradeModal();
    render();
    showToast(id ? "交易记录已修改" : "交易已记录，持仓和盈亏已更新");
  } catch (error) {
    showToast(error.message);
  }
}

async function handleTradeAction(event) {
  const button = event.target.closest("[data-trade-action]");
  if (!button) return;
  const id = Number(button.dataset.id);
  const trade = state.transactions.find((item) => Number(item.id) === id);
  if (!trade) return;
  if (button.dataset.tradeAction === "edit") {
    openTradeModal({
      id: trade.id,
      tradeDate: trade.tradeDate,
      market: trade.market === "美股" ? "US" : trade.market === "港股" ? "HK" : "A",
      side: trade.side,
      name: trade.name,
      ticker: trade.ticker,
      qty: trade.qty,
      price: trade.price,
      fee: trade.fee || 0,
      realizedPnl: trade.realizedPnl || 0
    });
    return;
  }
  const confirmed = window.confirm(`确定删除 ${trade.tradeDate} ${trade.name} 的交易记录吗？`);
  if (!confirmed) return;
  try {
    applyDashboard(await api(`/api/transactions/${id}`, { method: "DELETE" }));
    render();
    showToast("交易记录已删除");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteCurrentTrade() {
  const form = document.getElementById("tradeForm");
  const id = form.elements.id.value;
  if (!id) return;
  const confirmed = window.confirm("确定删除这笔交易记录吗？");
  if (!confirmed) return;
  try {
    applyDashboard(await api(`/api/transactions/${id}`, { method: "DELETE" }));
    closeTradeModal();
    render();
    showToast("交易记录已删除");
  } catch (error) {
    showToast(error.message);
  }
}

async function handleHoldingAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const id = Number(button.dataset.id);
  const holding = state.holdings.find((item) => Number(item.id) === id);
  if (!holding) return;

  if (button.dataset.action === "edit") {
    openModal(holding);
    return;
  }
  if (button.dataset.action === "trade") {
    openTradeModal({
      market: holding.market === "美股" ? "US" : holding.market === "港股" ? "HK" : "A",
      name: holding.name,
      ticker: holding.ticker,
      qty: holding.qty,
      price: holding.price
    });
  }
}

async function deleteCurrentHolding() {
  const form = document.getElementById("holdingForm");
  const id = form.elements.id.value;
  if (!id) return;
  const name = form.elements.name.value;
  const ticker = form.elements.ticker.value;
  const confirmed = window.confirm(`确定删除 ${name}（${ticker}）吗？`);
  if (!confirmed) return;
  try {
    applyDashboard(await api(`/api/holdings/${id}`, { method: "DELETE" }));
    closeModal();
    render();
    showToast("持仓已删除");
  } catch (error) {
    showToast(error.message);
  }
}

async function importCsv(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = await api("/api/import", {
      method: "POST",
      headers: { "Content-Type": "text/csv; charset=utf-8" },
      body: text
    });
    applyDashboard(data);
    render();
    showToast(`已导入 ${data.imported} 条持仓`);
  } catch (error) {
    showToast(error.message);
  } finally {
    document.getElementById("csvInput").value = "";
  }
}

async function replaceAllHoldings(holdings, cash) {
  applyDashboard(await api("/api/holdings/replace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ holdings, cash })
  }));
  render();
  showToast(`已替换为 ${holdings.length} 条持仓`);
}

async function clearHoldings() {
  const confirmed = window.confirm("确定清空当前全部持仓吗？这个操作会删除测试数据。");
  if (!confirmed) return;
  try {
    applyDashboard(await api("/api/holdings", { method: "DELETE" }));
    render();
    showToast("持仓已清空，可以导入或让我根据截图替换");
  } catch (error) {
    showToast(error.message);
  }
}

window.replaceAllHoldingsFromCodex = replaceAllHoldings;

function openCsvPicker() {
  showToast("CSV表头：market,name,ticker,qty,cost,price,currency");
  document.getElementById("csvInput").click();
}

function loadAutoRefreshSettings() {
  const saved = localStorage.getItem(AUTO_REFRESH_KEY);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    state.autoRefresh.enabled = Boolean(parsed.enabled);
    state.autoRefresh.interval = Number(parsed.interval) || 60;
  } catch {
    state.autoRefresh.enabled = false;
    state.autoRefresh.interval = 60;
  }
  document.getElementById("autoRefreshToggle").checked = state.autoRefresh.enabled;
  document.getElementById("refreshIntervalSelect").value = String(state.autoRefresh.interval);
}

function saveAutoRefreshSettings() {
  localStorage.setItem(AUTO_REFRESH_KEY, JSON.stringify({
    enabled: state.autoRefresh.enabled,
    interval: state.autoRefresh.interval
  }));
}

function syncAutoRefreshTimer() {
  if (state.autoRefresh.timer) {
    window.clearInterval(state.autoRefresh.timer);
    state.autoRefresh.timer = null;
  }
  if (!state.autoRefresh.enabled) {
    renderQuoteStatus();
    return;
  }
  state.autoRefresh.timer = window.setInterval(refreshData, state.autoRefresh.interval * 1000);
  renderQuoteStatus();
}

function setAutoRefresh(enabled) {
  state.autoRefresh.enabled = enabled;
  saveAutoRefreshSettings();
  syncAutoRefreshTimer();
  showToast(enabled ? `已开启每 ${state.autoRefresh.interval} 秒自动刷新` : "已关闭自动刷新");
}

function setAutoRefreshInterval(seconds) {
  state.autoRefresh.interval = Number(seconds);
  saveAutoRefreshSettings();
  syncAutoRefreshTimer();
  showToast(`刷新频率已设为 ${seconds} 秒`);
}

function cycleTrendRange() {
  const next = state.trendRange === 7 ? 30 : state.trendRange === 30 ? 90 : 7;
  state.trendRange = next;
  state.assetHoverIndex = null;
  setText("trendRangeBtn", `近${next}天⌄`);
  renderCharts();
  showToast(`资产走势已切换到近${next}天`);
}

function updateAssetTrendSelection(event) {
  const canvas = document.getElementById("assetChart");
  const points = canvas?._chartPoints || [];
  if (!canvas || !points.length) return;
  const source = event.touches?.[0] || event.changedTouches?.[0] || event;
  const rect = canvas.getBoundingClientRect();
  const scaleX = (canvas._chartCssWidth || rect.width) / rect.width;
  const x = (source.clientX - rect.left) * scaleX;
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  points.forEach((point, idx) => {
    const distance = Math.abs(point.x - x);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = idx;
    }
  });
  state.assetHoverIndex = nearestIndex;
  renderCharts();
}

function updateReturnSelection(event) {
  const canvas = document.getElementById("returnChart");
  const points = canvas?._chartPoints || [];
  if (!canvas || !points.length || state.pnlView === "calendar") return;
  const source = event.touches?.[0] || event.changedTouches?.[0] || event;
  const rect = canvas.getBoundingClientRect();
  const scaleX = (canvas._chartCssWidth || rect.width) / rect.width;
  const x = (source.clientX - rect.left) * scaleX;
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  points.forEach((point, idx) => {
    const distance = Math.abs(point.x - x);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = idx;
    }
  });
  state.returnHoverIndex = nearestIndex;
  renderCharts();
}

function shiftPnlCalendarMonth(delta) {
  const rows = pnlRowsSorted();
  const baseMonth = state.calendarMonth || (rows.length ? rows[rows.length - 1].date.slice(0, 7) : new Date().toISOString().slice(0, 7));
  const [year, month] = baseMonth.split("-").map(Number);
  if (state.pnlPeriod === "year") return;
  if (state.pnlPeriod === "month") {
    const nextYear = year + delta;
    state.calendarMonth = `${nextYear}-01`;
    renderPnlCalendar();
    return;
  }
  const next = new Date(year, month - 1 + delta, 1);
  state.calendarMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  renderPnlCalendar();
}

function showPanelMessage(kind) {
  if (kind === "news") {
    loadMarketIntel(true);
    showToast("正在刷新公开资讯和资金流");
    return;
  }
  loadMarketIntel(true);
  showToast("正在刷新大盘/板块资金流和风险摘要");
}

function jumpToPanel(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.remove("highlight-panel");
  window.setTimeout(() => target.classList.add("highlight-panel"), 30);
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem("yaohTheme", nextTheme);
  const toggle = document.getElementById("themeToggle");
  if (toggle) {
    toggle.textContent = nextTheme === "dark" ? "浅色" : "深色";
    toggle.setAttribute("aria-label", `切换到${nextTheme === "dark" ? "浅色" : "深色"}主题`);
  }
  if (document.getElementById("assetChart")) renderCharts();
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  applyTheme(current === "dark" ? "light" : "dark");
}

applyTheme(document.documentElement.dataset.theme);

document.getElementById("refreshTop").addEventListener("click", refreshData);
document.getElementById("refreshSide").addEventListener("click", refreshData);
document.getElementById("themeToggle")?.addEventListener("click", toggleTheme);
document.getElementById("autoRefreshToggle").addEventListener("change", (event) => setAutoRefresh(event.target.checked));
document.getElementById("refreshIntervalSelect").addEventListener("change", (event) => setAutoRefreshInterval(event.target.value));
ensureCashControls();
document.getElementById("addBtn").addEventListener("click", openModal);
document.getElementById("topAddBtn").addEventListener("click", openModal);
document.getElementById("tradeBtn").addEventListener("click", () => openTradeModal());
document.getElementById("cashBtn").addEventListener("click", openCashModal);
document.getElementById("closeCashModal").addEventListener("click", closeCashModal);
document.getElementById("cancelCashModal").addEventListener("click", closeCashModal);
document.getElementById("cashForm").elements.market.addEventListener("change", syncCashFormCurrent);
document.getElementById("cashForm").addEventListener("submit", submitCash);
document.getElementById("tradeRecordAddBtn").addEventListener("click", () => openTradeModal());
document.getElementById("clearBtn").addEventListener("click", clearHoldings);
document.getElementById("closeModal").addEventListener("click", closeModal);
document.getElementById("cancelModal").addEventListener("click", closeModal);
document.getElementById("deleteHoldingBtn").addEventListener("click", deleteCurrentHolding);
document.getElementById("holdingForm").addEventListener("submit", submitHolding);
document.getElementById("closeTradeModal").addEventListener("click", closeTradeModal);
document.getElementById("cancelTradeModal").addEventListener("click", closeTradeModal);
document.getElementById("deleteTradeBtn").addEventListener("click", deleteCurrentTrade);
document.getElementById("tradeForm").addEventListener("submit", submitTrade);
document.getElementById("importBtn").addEventListener("click", openCsvPicker);
document.getElementById("topImportBtn").addEventListener("click", openCsvPicker);
document.getElementById("importNav").addEventListener("click", openCsvPicker);
document.getElementById("csvInput").addEventListener("change", (event) => importCsv(event.target.files[0]));
document.getElementById("aRows").addEventListener("click", handleHoldingAction);
document.getElementById("hRows").addEventListener("click", handleHoldingAction);
document.getElementById("uRows").addEventListener("click", handleHoldingAction);
document.getElementById("tradeRows").addEventListener("click", handleTradeAction);
document.getElementById("trendRangeBtn").addEventListener("click", cycleTrendRange);
document.getElementById("assetChart").addEventListener("mousemove", updateAssetTrendSelection);
document.getElementById("assetChart").addEventListener("click", updateAssetTrendSelection);
document.getElementById("assetChart").addEventListener("touchstart", updateAssetTrendSelection, { passive: true });
document.getElementById("assetChart").addEventListener("touchmove", updateAssetTrendSelection, { passive: true });

document.querySelectorAll(".metric-card, .panel, .market-zone").forEach((surface) => {
  surface.addEventListener("pointermove", (event) => {
    const rect = surface.getBoundingClientRect();
    surface.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    surface.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
  });
});
document.getElementById("returnChart").addEventListener("mousemove", updateReturnSelection);
document.getElementById("returnChart").addEventListener("click", updateReturnSelection);
document.getElementById("returnChart").addEventListener("touchstart", updateReturnSelection, { passive: true });
document.getElementById("returnChart").addEventListener("touchmove", updateReturnSelection, { passive: true });
document.getElementById("pnlCalendarPrev").addEventListener("click", () => shiftPnlCalendarMonth(-1));
document.getElementById("pnlCalendarNext").addEventListener("click", () => shiftPnlCalendarMonth(1));
document.getElementById("watchToggleBtn").addEventListener("click", () => {
  state.watchMode = state.watchMode === "all" ? "holdings" : "all";
  renderWatchlist();
  showToast(state.watchMode === "all" ? "自选观察：全部股票" : "自选观察：仅当前持仓");
});
document.getElementById("newsRefreshBtn").addEventListener("click", () => loadMarketIntel(true));
document.getElementById("newsPrevBtn").addEventListener("click", () => turnNewsPage(-1));
document.getElementById("newsMoreBtn").addEventListener("click", () => turnNewsPage(1));
document.getElementById("riskMoreBtn").addEventListener("click", () => showPanelMessage("risk"));
document.getElementById("advisorAskBtn").addEventListener("click", askAdvisor);
document.getElementById("advisorModelSelect").addEventListener("change", changeAdvisorModel);
document.querySelectorAll("[data-pnl-view]").forEach((button) => {
  button.addEventListener("click", () => {
    state.pnlView = button.dataset.pnlView;
    state.returnHoverIndex = null;
    document.querySelectorAll("[data-pnl-view]").forEach((item) => item.classList.toggle("active", item === button));
    renderCharts();
    showToast(button.textContent.trim());
  });
});
document.querySelectorAll("[data-pnl-period]").forEach((button) => {
  button.addEventListener("click", () => {
    state.pnlPeriod = button.dataset.pnlPeriod;
    state.returnHoverIndex = null;
    state.calendarMonth = null;
    document.querySelectorAll("[data-pnl-period]").forEach((item) => item.classList.toggle("active", item === button));
    renderCharts();
    showToast(`盈亏维度：${button.textContent.trim()}`);
  });
});
document.querySelectorAll(".section-jump").forEach((button) => {
  button.addEventListener("click", () => jumpToPanel(button.dataset.scroll));
});
document.querySelectorAll("[data-scroll]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    jumpToPanel(button.dataset.scroll);
  });
});

updateTime();
loadDashboard();
window.setInterval(updateTime, 1000);
