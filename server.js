require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const client = require('./src/tradovate');
const { computeRealizedTrades, buildStats } = require('./src/analytics');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', env: process.env.TRADOVATE_ENV || 'demo' }));

// Auth status
app.get('/api/auth/status', async (req, res) => {
  try {
    await client.ensureToken();
    res.json({ authenticated: true });
  } catch (err) {
    res.status(401).json({ authenticated: false, error: err.message });
  }
});

// Core dashboard data
app.get('/api/dashboard', async (req, res) => {
  try {
    const [accounts, fills, positions] = await Promise.all([
      client.getAccounts(),
      client.getFills(),
      client.getPositions()
    ]);

    // Fetch contract details for all fills
    const contractIds = [...new Set(fills.map(f => f.contractId).filter(Boolean))];
    const contracts = await client.getContractBatch(contractIds);

    // Also get contract details for open positions
    const posContractIds = [...new Set(positions.map(p => p.contractId).filter(Boolean))];
    await client.getContractBatch(posContractIds);
    const allContracts = client.contractCache;

    // Compute realized trade stats
    const realizedTrades = computeRealizedTrades(fills, allContracts);
    const stats = buildStats(realizedTrades);

    // Enrich open positions
    const openPositions = positions
      .filter(p => p.netPos !== 0)
      .map(p => {
        const contract = allContracts[p.contractId] || {};
        const tickSize = contract.tickSize || 0.25;
        const tickValue = contract.tickValue || 12.5;
        const pointValue = tickValue / tickSize;
        const unrealizedPnl = p.netPos * (p.prevPrice ? (p.prevPrice - p.openPnl) : 0);
        return {
          id: p.id,
          symbol: contract.name || `Contract ${p.contractId}`,
          netPos: p.netPos,
          openPnl: Math.round((p.openPnl || 0) * 100) / 100,
          side: p.netPos > 0 ? 'Long' : 'Short',
          qty: Math.abs(p.netPos),
          contractId: p.contractId
        };
      });

    // Account balance info
    let balanceInfo = {};
    if (accounts.length > 0) {
      try {
        const snap = await client.getCashBalanceSnapshot(accounts[0].id);
        balanceInfo = {
          accountId: accounts[0].id,
          name: accounts[0].name,
          balance: snap.cashBalance || snap.totalCashValue || 0,
          openPnl: snap.openPnl || 0,
          realizedPnl: snap.realizedPnl || 0
        };
      } catch (_) {
        balanceInfo = { name: accounts[0]?.name || 'Account' };
      }
    }

    res.json({
      stats,
      openPositions,
      recentTrades: stats.recentTrades,
      account: balanceInfo,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    const status = err.message.includes('must be set') || err.message.includes('failed') ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Calendar data endpoint
app.get('/api/calendar', async (req, res) => {
  try {
    const fills = await client.getFills();
    const contractIds = [...new Set(fills.map(f => f.contractId).filter(Boolean))];
    await client.getContractBatch(contractIds);
    const contracts = client.contractCache;

    const realizedTrades = computeRealizedTrades(fills, contracts);
    const stats = buildStats(realizedTrades);

    res.json({ dailyPnl: stats.dailyPnl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Cameron Dashboard running on http://localhost:${PORT}`);
  console.log(`Tradovate environment: ${process.env.TRADOVATE_ENV || 'demo'}`);
});
