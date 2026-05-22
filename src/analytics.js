// Compute realized P&L from fills using FIFO matching.
// pointValue = tickValue / tickSize (e.g. ES = 12.5 / 0.25 = $50/pt)
function computeRealizedTrades(fills, contracts) {
  const byContract = {};

  const sorted = [...fills].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  for (const fill of sorted) {
    const cid = fill.contractId;
    if (!byContract[cid]) byContract[cid] = { queue: [], trades: [] };
    const state = byContract[cid];

    const contract = contracts[cid] || {};
    const tickSize = contract.tickSize || 0.25;
    const tickValue = contract.tickValue || 12.5;
    const pointValue = tickValue / tickSize;
    const symbol = contract.name || `Contract ${cid}`;

    const isBuy = fill.action === 'Buy';
    const qty = fill.qty || 1;
    const price = fill.price;

    if (state.queue.length === 0 || (state.queue[0].long === isBuy)) {
      // Adding to or opening position
      state.queue.push({ price, qty, long: isBuy });
    } else {
      // Closing position
      let remaining = qty;
      let tradePnl = 0;

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
        timestamp: fill.timestamp,
        symbol,
        contractId: cid,
        pnl: tradePnl,
        qty: qty - remaining
      });

      if (remaining > 0) {
        state.queue.push({ price, qty: remaining, long: isBuy });
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

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const breakeven = trades.filter(t => t.pnl === 0);

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
    const day = t.timestamp.slice(0, 10);
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
