const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const db = new DatabaseSync(path.join(root, "portfolio.db"));

const FX = 191671.17 / 28442.34;
const HKD_FX = 50175 / 58042.44;

const holidays = new Set([
  "2026-01-01",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-04-03",
  "2026-05-01",
  "2026-06-19",
  "2026-10-01",
  "2026-10-02"
]);

function currencyToCny(value, currency) {
  if (currency === "USD") return value * FX;
  if (currency === "HKD") return value * HKD_FX;
  return value;
}

function keyOf(item) {
  return `${item.market}|${item.ticker}`;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function ymdCompact(date) {
  return date.replaceAll("-", "");
}

function isTradingDay(date) {
  const key = dateKey(date);
  const week = date.getDay();
  return week !== 0 && week !== 6 && !holidays.has(key);
}

function parseKlineRows(rows = []) {
  const map = new Map();
  rows.forEach((line) => {
    const parts = String(line).split(",");
    const date = parts[0];
    const close = Number(parts[2]);
    if (date && Number.isFinite(close) && close > 0) map.set(date, close);
  });
  return map;
}

function eastmoneySecid(market, ticker) {
  if (market === "港股") return `116.${String(ticker).replace(/\.HK$/i, "")}`;
  if (String(ticker).startsWith("6")) return `1.${ticker}`;
  return `0.${ticker}`;
}

async function fetchEastmoneyHistory(market, ticker, start, end) {
  const secid = eastmoneySecid(market, ticker);
  const fields = "f51,f52,f53,f54,f55,f56,f57,f58";
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6&fields2=${fields}&klt=101&fqt=1&beg=${ymdCompact(start)}&end=${ymdCompact(end)}`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`Eastmoney ${ticker} HTTP ${response.status}`);
  const json = await response.json();
  return parseKlineRows(json?.data?.klines || []);
}

async function fetchYahooHistory(ticker, start, end) {
  const period1 = Math.floor(new Date(`${start}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(new Date(`${end}T23:59:59Z`).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`Yahoo ${ticker} HTTP ${response.status}`);
  const json = await response.json();
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const map = new Map();
  timestamps.forEach((seconds, index) => {
    const close = Number(closes[index]);
    if (!Number.isFinite(close) || close <= 0) return;
    const date = new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
    map.set(date, close);
  });
  return map;
}

async function fetchHistory(market, ticker, start, end) {
  if (market === "美股") return fetchYahooHistory(ticker, start, end);
  return fetchEastmoneyHistory(market, ticker, start, end);
}

function lastPriceOnOrBefore(priceMap, date) {
  if (priceMap.has(date)) return priceMap.get(date);
  const keys = Array.from(priceMap.keys()).filter((key) => key <= date).sort();
  return keys.length ? priceMap.get(keys[keys.length - 1]) : null;
}

function previousTradingDate(date) {
  const cursor = new Date(`${date}T00:00:00`);
  do {
    cursor.setDate(cursor.getDate() - 1);
  } while (!isTradingDay(cursor));
  return dateKey(cursor);
}

function currentHoldings() {
  return db.prepare(`
    SELECT market, name, ticker, qty, cost, price, currency
    FROM holdings
  `).all();
}

function transactions() {
  return db.prepare(`
    SELECT trade_date AS tradeDate, market, ticker, name, side, qty, price, fee, currency, realized_pnl AS realizedPnl
    FROM transactions
    ORDER BY trade_date ASC, id ASC
  `).all();
}

function snapshots() {
  return db.prepare(`
    SELECT snapshot_date AS date, total_value AS totalValue, market_value AS marketValue, cash, day_pnl AS dayPnl,
      realized_pnl AS realizedPnl, unrealized_pnl AS unrealizedPnl
    FROM daily_snapshots
    ORDER BY snapshot_date ASC
  `).all();
}

function deriveCostFromRealized(trade) {
  const qty = Math.max(Number(trade.qty || 0), 1);
  const fee = Number(trade.fee || 0);
  const realized = Number(trade.realizedPnl || 0);
  const cost = Number(trade.price) - ((realized + fee) / qty);
  return Number.isFinite(cost) && cost > 0 ? cost : Number(trade.price);
}

function positionsAt(date, holdings, trades) {
  const positions = new Map();
  holdings.forEach((item) => {
    positions.set(keyOf(item), {
      market: item.market,
      name: item.name,
      ticker: item.ticker,
      qty: Number(item.qty),
      cost: Number(item.cost),
      currency: item.currency
    });
  });

  [...trades].reverse().forEach((trade) => {
    if (trade.tradeDate <= date) return;
    const key = keyOf(trade);
    const current = positions.get(key) || {
      market: trade.market,
      name: trade.name,
      ticker: trade.ticker,
      qty: 0,
      cost: Number(trade.price),
      currency: trade.currency
    };
    const qty = Number(trade.qty);
    if (trade.side === "BUY") {
      const oldQty = current.qty - qty;
      if (oldQty <= 0.000001) {
        positions.delete(key);
      } else {
        const oldCost = ((current.qty * current.cost) - (qty * Number(trade.price))) / oldQty;
        current.qty = oldQty;
        current.cost = Number.isFinite(oldCost) && oldCost > 0 ? oldCost : current.cost;
        positions.set(key, current);
      }
    } else {
      const addCost = deriveCostFromRealized(trade);
      const oldQty = current.qty + qty;
      const oldCost = ((current.qty * current.cost) + (qty * addCost)) / oldQty;
      current.qty = oldQty;
      current.cost = Number.isFinite(oldCost) && oldCost > 0 ? oldCost : addCost;
      positions.set(key, current);
    }
  });

  return Array.from(positions.values()).filter((item) => item.qty > 0.000001);
}

function cashForDate(date, snapshotRows) {
  const exact = snapshotRows.find((row) => row.date === date);
  if (exact) return Number(exact.cash || 0);
  const previous = [...snapshotRows].filter((row) => row.date < date).at(-1);
  if (previous) return Number(previous.cash || 0);
  return Number(snapshotRows[0]?.cash || 0);
}

function realizedForDate(date, trades) {
  return trades
    .filter((trade) => trade.tradeDate === date)
    .reduce((sum, trade) => sum + currencyToCny(Number(trade.realizedPnl || 0), trade.currency), 0);
}

async function main() {
  const holdings = currentHoldings();
  const trades = transactions();
  const snapshotRows = snapshots();
  if (!holdings.length || !snapshotRows.length) {
    console.log("No holdings or snapshots to backfill.");
    return;
  }

  const start = snapshotRows[0].date;
  const end = dateKey(new Date());
  const tickers = new Map();
  [...holdings, ...trades].forEach((item) => {
    if (!item.market || !item.ticker) return;
    tickers.set(`${item.market}|${item.ticker}`, { market: item.market, ticker: item.ticker });
  });

  const histories = new Map();
  for (const item of tickers.values()) {
    try {
      histories.set(`${item.market}|${item.ticker}`, await fetchHistory(item.market, item.ticker, start, end));
    } catch (error) {
      console.warn(`history failed ${item.market} ${item.ticker}: ${error.message}`);
      histories.set(`${item.market}|${item.ticker}`, new Map());
    }
  }

  const existingDates = new Set(snapshotRows.map((row) => row.date));
  const rowsToInsert = [];
  const insert = db.prepare(`
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
  `);

  let previousTotal = null;
  for (const cursor = new Date(`${start}T00:00:00`); cursor <= new Date(`${end}T00:00:00`); cursor.setDate(cursor.getDate() + 1)) {
    if (!isTradingDay(cursor)) continue;
    const date = dateKey(cursor);
    const existing = snapshotRows.find((row) => row.date === date);
    if (existing) {
      previousTotal = Number(existing.totalValue || 0);
      continue;
    }

    const previousDate = previousTradingDate(date);
    const positions = positionsAt(date, holdings, trades);
    let dayPnl = realizedForDate(date, trades);
    for (const item of positions) {
      const priceMap = histories.get(`${item.market}|${item.ticker}`) || new Map();
      const price = lastPriceOnOrBefore(priceMap, date);
      const previousPrice = lastPriceOnOrBefore(priceMap, previousDate);
      if (!price || !previousPrice) continue;
      dayPnl += currencyToCny((price - previousPrice) * item.qty, item.currency);
    }
    const previousSnapshot = [...snapshotRows, ...rowsToInsert].filter((row) => row.date < date).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    const cash = previousSnapshot ? Number(previousSnapshot.cash || 0) : cashForDate(date, snapshotRows);
    const totalValue = (previousTotal ?? Number(previousSnapshot?.totalValue || 0)) + dayPnl;
    const marketValue = totalValue - cash;
    const realizedPnl = realizedForDate(date, trades);
    const unrealizedPnl = Number(previousSnapshot?.unrealizedPnl || 0) + dayPnl;

    rowsToInsert.push({
      date,
      totalValue: Number(totalValue.toFixed(2)),
      marketValue: Number(marketValue.toFixed(2)),
      cash: Number(cash.toFixed(2)),
      dayPnl: Number(dayPnl.toFixed(2)),
      realizedPnl: Number(realizedPnl.toFixed(2)),
      unrealizedPnl: Number(unrealizedPnl.toFixed(2))
    });
    previousTotal = totalValue;
  }

  db.exec("BEGIN");
  try {
    rowsToInsert.forEach((row) => {
      insert.run(row.date, row.totalValue, row.marketValue, row.cash, row.dayPnl, row.realizedPnl, row.unrealizedPnl);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  console.log(JSON.stringify({ inserted: rowsToInsert.length, rows: rowsToInsert }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
