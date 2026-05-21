const FX = 7.22;
const FILE_MODE = window.location.protocol === "file:";
const STATIC_PAGES_MODE = FILE_MODE || window.location.hostname.endsWith("github.io");
const STORAGE_KEY = "investment-dashboard-local-data";
const AUTO_REFRESH_KEY = "investment-dashboard-auto-refresh";
const defaultDashboard = {
  cash: 71904,
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
  }
};

function money(value, currency = "CNY") {
  const symbol = currency === "USD" ? "$" : "¥";
  return `${symbol} ${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function compactMoney(value, currency = "CNY") {
  const symbol = currency === "USD" ? "$" : "¥";
  return `${symbol}${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tableMoney(value, currency = "CNY") {
  const symbol = currency === "USD" ? "$" : "¥";
  const number = Math.abs(Number(value));
  const sign = Number(value) < 0 ? "-" : "";
  if (number >= 10000) return `${sign}${symbol}${(number / 10000).toFixed(2)}万`;
  return `${sign}${symbol}${number.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cnyValue(holding, useCost = false) {
  const price = useCost ? holding.cost : holding.price;
  const raw = holding.qty * price;
  return holding.currency === "USD" ? raw * FX : raw;
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
  const market = state.holdings.reduce((sum, item) => sum + cnyValue(item), 0);
  const total = market + state.cash;
  const pnl = market - invested;
  const daily = state.holdings.reduce((sum, item) => sum + Number(item.dayPnl || 0), 0);
  const dayBase = state.holdings.reduce((sum, item) => sum + Number(item.dayBaseValue || (cnyValue(item) - Number(item.dayPnl || 0))), 0);
  return { invested, market, total, pnl, daily, dayBase };
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
    if (input.cash !== undefined) data.cash = Number(input.cash);
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
  const dailyRate = state.summaries?.total?.dayPnlRate ?? ((t.daily / Math.max(t.dayBase, 1)) * 100);
  const totalRate = (t.pnl / Math.max(t.invested, 1)) * 100;
  const cashRate = (state.cash / Math.max(t.total, 1)) * 100;

  setText("totalAssets", money(t.total));
  setText("dailyRate", percent(dailyRate));
  setText("dailyPnl", `${t.daily >= 0 ? "+" : ""}${money(t.daily)}`);
  setText("todayPnl", `${t.daily >= 0 ? "+" : ""}${money(t.daily)}`);
  setText("todayRate", percent(dailyRate));
  setText("totalPnl", `${t.pnl >= 0 ? "+" : ""}${money(t.pnl)}`);
  setText("totalRate", percent(totalRate));
  setText("cashRate", `${cashRate.toFixed(2)}%`);
  setText("cashValue", money(state.cash));
  setText("availableCash", money(state.cash * 0.9485));
  setText("availableRate", `${state.cash ? ((state.cash * 0.9485) / state.cash * 100).toFixed(2) : "0.00"}%`);
  setText("donutTotal", `¥ ${Math.round(t.total).toLocaleString("zh-CN")}`);

  document.getElementById("todayPnl").className = classFor(t.daily);
  document.getElementById("totalPnl").className = classFor(t.pnl);

  const aValue = state.holdings.filter((h) => h.market === "A股").reduce((sum, h) => sum + cnyValue(h), 0);
  const uValue = state.holdings.filter((h) => h.market === "美股").reduce((sum, h) => sum + cnyValue(h), 0);
  setText("asharePct", `${((aValue / Math.max(t.total, 1)) * 100).toFixed(1)}%`);
  setText("usPct", `${((uValue / Math.max(t.total, 1)) * 100).toFixed(1)}%`);
  setText("cashPct", `${((state.cash / Math.max(t.total, 1)) * 100).toFixed(1)}%`);
  setText("ashareValue", money(aValue));
  setText("usValue", money(uValue));
  setText("cashLegend", money(state.cash));

  const aEnd = (aValue / Math.max(t.total, 1)) * 100;
  const uEnd = aEnd + (uValue / Math.max(t.total, 1)) * 100;
  document.getElementById("donut").style.background =
    `conic-gradient(var(--blue) 0 ${aEnd}%, var(--green) ${aEnd}% ${uEnd}%, var(--orange) ${uEnd}% 100%)`;
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

function drawLineChart(canvasId, series, lines, formatter) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const pad = { top: 18, right: 18, bottom: 28, left: 54 };
  ctx.clearRect(0, 0, width, height);
  ctx.font = "12px Microsoft YaHei, sans-serif";
  ctx.lineWidth = 1;

  const allValues = series.flatMap((s) => s.values);
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = Math.max(max - min, 1);

  for (let i = 0; i <= 5; i += 1) {
    const y = pad.top + ((height - pad.top - pad.bottom) / 5) * i;
    ctx.strokeStyle = "rgba(138, 162, 204, 0.14)";
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    const value = max - (range / 5) * i;
    ctx.fillStyle = "#9da9bf";
    ctx.fillText(formatter(value), 8, y + 4);
  }

  series.forEach((item) => {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.width || 2;
    ctx.beginPath();
    item.values.forEach((value, idx) => {
      const x = pad.left + ((width - pad.left - pad.right) / Math.max(item.values.length - 1, 1)) * idx;
      const y = pad.top + (1 - (value - min) / range) * (height - pad.top - pad.bottom);
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
      gradient.addColorStop(0, item.fill);
      gradient.addColorStop(1, "rgba(52, 120, 255, 0)");
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  });

  if (lines?.length) {
    lines.forEach((label, idx) => {
      const x = pad.left + ((width - pad.left - pad.right) / Math.max(lines.length - 1, 1)) * idx;
      ctx.fillStyle = "#9da9bf";
      ctx.fillText(label, x - 16, height - 8);
    });
  }
}

function makeAssetSeries() {
  const t = totals();
  const length = state.trendRange;
  const trendStep = state.trendRange === 7 ? 960 : state.trendRange === 90 ? 720 : 1850;
  return Array.from({ length }, (_, i) => {
    const trend = i * trendStep;
    const wave = Math.sin((i + state.seed) / 2) * 4300;
    const step = i > length * 0.62 ? 11000 : 0;
    return t.total - 56000 + trend + wave + step;
  });
}

function makeReturnSeries(base, volatility, lift) {
  return Array.from({ length: 28 }, (_, i) => {
    const curve = base + Math.sin((i + state.seed) / 2.5) * volatility + i * lift;
    const dip = i === 20 ? -5.5 : 0;
    return curve + dip;
  });
}

function pnlSeries() {
  const rows = state.pnlCalendar;
  if (!rows.length) return [];
  if (state.pnlPeriod === "day") return rows.map((row) => ({ label: row.date.slice(5), value: Number(row.dayPnl || 0) }));
  const grouped = new Map();
  rows.forEach((row) => {
    const key = state.pnlPeriod === "month" ? row.date.slice(0, 7) : row.date.slice(0, 4);
    grouped.set(key, (grouped.get(key) || 0) + Number(row.dayPnl || 0));
  });
  return Array.from(grouped, ([label, value]) => ({ label, value }));
}

function renderPnlCalendar() {
  const container = document.getElementById("pnlCalendar");
  const rows = state.pnlCalendar;
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const byDay = new Map(rows.map((row) => [Number(row.date.slice(8, 10)), Number(row.dayPnl || 0)]));
  container.innerHTML = Array.from({ length: days }, (_, idx) => {
    const day = idx + 1;
    const value = byDay.get(day);
    const cls = value === undefined ? "" : value >= 0 ? "gain-bg" : "loss-bg";
    return `<button class="${cls}" title="${value === undefined ? "暂无记录" : tableMoney(value)}"><b>${day}</b><span>${value === undefined ? "--" : tableMoney(value)}</span></button>`;
  }).join("");
}

function renderCharts() {
  const trendLabels = state.trendRange === 7
    ? ["05-09", "05-10", "05-11", "05-12", "05-13", "05-14", "05-15"]
    : state.trendRange === 90
      ? ["02-15", "03-01", "03-15", "04-01", "04-15", "05-01", "05-15"]
      : ["04-20", "04-27", "05-04", "05-11", "05-18"];
  drawLineChart("assetChart", [{
    values: makeAssetSeries(),
    color: "#3478ff",
    fill: "rgba(52, 120, 255, 0.28)",
    width: 3
  }], trendLabels, (v) => `${Math.round(v / 1000)},000`);

  const pnl = pnlSeries();
  const chart = document.getElementById("returnChart");
  const calendar = document.getElementById("pnlCalendar");
  chart.hidden = state.pnlView === "calendar";
  calendar.hidden = state.pnlView !== "calendar";
  if (state.pnlView === "calendar") {
    renderPnlCalendar();
  } else if (!pnl.length) {
    const ctx = chart.getContext("2d");
    ctx.clearRect(0, 0, chart.width, chart.height);
    ctx.fillStyle = "#9da9bf";
    ctx.font = "14px Microsoft YaHei, sans-serif";
    ctx.fillText("暂无真实盈亏记录，刷新行情或记录交易后生成", 24, 42);
  } else {
    drawLineChart("returnChart", [{ values: pnl.map((row) => row.value), color: "#3478ff", width: 3 }], pnl.map((row) => row.label), (v) => tableMoney(v));
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
    </tr>
  `).join("") : `<tr><td colspan="7">暂无交易记录。点击右上角“记录交易”开始记录买入、卖出或清仓。</td></tr>`;
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
  form.elements.tradeDate.value = new Date().toISOString().slice(0, 10);
  Object.entries(defaults).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value;
  });
  document.getElementById("tradeModalBackdrop").hidden = false;
}

function closeTradeModal() {
  document.getElementById("tradeModalBackdrop").hidden = true;
  document.getElementById("tradeForm").reset();
}

async function submitTrade(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    applyDashboard(await api("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }));
    closeTradeModal();
    render();
    showToast("交易已记录，持仓和盈亏已更新");
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
      market: holding.market === "美股" ? "US" : "A",
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
  setText("trendRangeBtn", `近${next}天⌄`);
  renderCharts();
  showToast(`资产走势已切换到近${next}天`);
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

document.getElementById("refreshTop").addEventListener("click", refreshData);
document.getElementById("refreshSide").addEventListener("click", refreshData);
document.getElementById("autoRefreshToggle").addEventListener("change", (event) => setAutoRefresh(event.target.checked));
document.getElementById("refreshIntervalSelect").addEventListener("change", (event) => setAutoRefreshInterval(event.target.value));
document.getElementById("addBtn").addEventListener("click", openModal);
document.getElementById("topAddBtn").addEventListener("click", openModal);
document.getElementById("tradeBtn").addEventListener("click", () => openTradeModal());
document.getElementById("tradeRecordAddBtn").addEventListener("click", () => openTradeModal());
document.getElementById("clearBtn").addEventListener("click", clearHoldings);
document.getElementById("closeModal").addEventListener("click", closeModal);
document.getElementById("cancelModal").addEventListener("click", closeModal);
document.getElementById("deleteHoldingBtn").addEventListener("click", deleteCurrentHolding);
document.getElementById("holdingForm").addEventListener("submit", submitHolding);
document.getElementById("closeTradeModal").addEventListener("click", closeTradeModal);
document.getElementById("cancelTradeModal").addEventListener("click", closeTradeModal);
document.getElementById("tradeForm").addEventListener("submit", submitTrade);
document.getElementById("importBtn").addEventListener("click", openCsvPicker);
document.getElementById("topImportBtn").addEventListener("click", openCsvPicker);
document.getElementById("importNav").addEventListener("click", openCsvPicker);
document.getElementById("csvInput").addEventListener("change", (event) => importCsv(event.target.files[0]));
document.getElementById("aRows").addEventListener("click", handleHoldingAction);
document.getElementById("uRows").addEventListener("click", handleHoldingAction);
document.getElementById("trendRangeBtn").addEventListener("click", cycleTrendRange);
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
    document.querySelectorAll("[data-pnl-view]").forEach((item) => item.classList.toggle("active", item === button));
    renderCharts();
    showToast(button.textContent.trim());
  });
});
document.querySelectorAll("[data-pnl-period]").forEach((button) => {
  button.addEventListener("click", () => {
    state.pnlPeriod = button.dataset.pnlPeriod;
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
