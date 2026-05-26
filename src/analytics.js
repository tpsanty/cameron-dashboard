// Hard-coded dollar-per-point values for common futures contracts.
// Micro contracts come before their full-size counterparts so the
// startsWith() loop always matches the most-specific prefix first.
// This overrides whatever tickSize/tickValue the API returns, ensuring
// MNQ is never inflated to NQ values (or any other mis-match).
const POINT_VALUES = [
  ['MNQ', 2    ],  // Micro E-mini Nasdaq-100
  ['NQ',  20   ],  // E-mini Nasdaq-100
  ['MES', 5    ],  // Micro E-mini S&P 500
  ['ES',  50   ],  // E-mini S&P 500
  ['M2K', 5    ],  // Micro E-mini Russell 2000
  ['RTY', 50   ],  // E-mini Russell 2000
  ['MYM', 0.5  ],  // Micro E-mini DJIA
  ['YM',  5    ],  // E-mini DJIA
  ['MGC', 10   ],  // Micro Gold
  ['GC',  100  ],  // Gold
  ['MCL', 100  ],  // Micro WTI Crude Oil
  ['CL',  1000 ],  // WTI Crude Oil
  ['ZB',  1000 ],  // 30-Year T-Bond
  ['ZN',  1000 ],  // 10-Year T-Note
  ['ZF',  1000 ],  // 5-Year T-Note
  ['ZT',  2000 ],  // 2-Year T-Note
  ['SI',  5000 ],  // Silver
];

function resolvePointValue(symbol, tickSize, tickValue) {
  if (symbol) {
    const s = symbol.toUpperCase();
    for (const [prefix, pv] of POINT_VALUES) {
      if (s.startsWith(prefix)) return pv;
    }
  }
  // Unknown contract: derive from API tick data
  return (tickValue || 12.5) / (tickSize || 0.25);
}

// Compute realized P&L from fills using FIFO matching.
function computeRealizedTrades(fills, contracts) {
  const byContract = {};

  const sorted = [...fills].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  for (const fill of sorted) {
    const cid = fill.contractId;
    if (!byContract[cid]) byContract[cid] = { queue: [], trades: [] };
    const state = byContract[cid];

    const contract  = contracts[cid] || {};
    const tickSize  = contract.tickSize  || 0.25;
    const tickValue = contract.tickValue || 12.5;
    const symbol    = contract.name || `Contract ${cid}`;
    const pointValue = resolvePointValue(symbol, tickSize, tickValue);

    const isBuy = fill.action === 'Buy';
    const qty = fill.qty || 1;
    const price = fill.price;

    if (state.queue.length === 0 || (state.queue[0].long === isBuy)) {
      // Opening or adding to position — store the fill timestamp so we can
      // attribute P&L to the day the trade was ENTERED, not the day it closed.
      state.queue.push({ price, qty, long: isBuy, timestamp: fill.timestamp });
    } else {
      // Closing position
      let remaining = qty;
      let tradePnl = 0;

      // Capture the oldest (FIFO) entry's open date before we consume the queue
      const openTimestamp = state.queue[0].timestamp || fill.timestamp;

      while (remaining > 0 && state.queue.length > 0) {
        const entry = state.queue[0];
        const match = Math.min(remaining, entry.qty);
        const dir = entry.long ? 1 : -1;
        tradePnl += dir * (price - entry.price) * match * pointValue;
        entry.qty -= match;
        remaining -= match;
        if (entry.qty === 0) state.queue.shift();
      }

      state.trades.push({
        timestamp: fill.timestamp,   // close time — shown in the Recent Trades table
        openTimestamp,               // open time — used for calendar day attribution
        symbol,
        contractId: cid,
        pnl: tradePnl,
        qty: qty - remaining
      });

      if (remaining > 0) {
        state.queue.push({ price, qty: remaining, long: isBuy, timestamp: fill.timestamp });
      }
    }
  }

  const allTrades = [];
  for (const cid of Object.keys(byContract)) {
    allTrades.push(...byContract[cid].trades);
  }
  allTrades.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return allTrades;
}

function buildStats(trades) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: 0,
      totalPnl: 0,
      avgWin: 0,
      avgLoss: 0,
      bestTrade: 0,
      worstTrade: 0,
      riskReward: 0,
      dailyPnl: {},
      recentTrades: []
    };
  }

  const BREAKEVEN_THRESHOLD = 10;
  const wins = trades.filter(t => t.pnl > BREAKEVEN_THRESHOLD);
  const losses = trades.filter(t => t.pnl < -BREAKEVEN_THRESHOLD);
  const breakeven = trades.filter(t => Math.abs(t.pnl) <= BREAKEVEN_THRESHOLD);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const bestTrade = trades.reduce((m, t) => Math.max(m, t.pnl), -Infinity);
  const worstTrade = trades.reduce((m, t) => Math.min(m, t.pnl), Infinity);
  const winRate = (wins.length / trades.length) * 100;
  const riskReward = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  // Daily P&L map: "YYYY-MM-DD" -> pnl
  const dailyPnl = {};
  for (const t of trades) {
    const day = new Date(t.timestamp).toISOString().slice(0, 10);
    dailyPnl[day] = (dailyPnl[day] || 0) + t.pnl;
  }

  const recentTrades = [...trades]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 50)
    .map(t => ({
      ...t,
      pnl: Math.round(t.pnl * 100) / 100
    }));

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate: Math.round(winRate * 10) / 10,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    bestTrade: Math.round(bestTrade * 100) / 100,
    worstTrade: Math.round(worstTrade * 100) / 100,
    riskReward: Math.round(riskReward * 100) / 100,
    dailyPnl,
    recentTrades
  };
}

module.exports = { computeRealizedTrades, buildStats };
