'use strict';

// ── Config ─────────────────────────────────────────────────────────────────
const REFRESH_INTERVAL = 60; // seconds
const BREAKEVEN_THRESHOLD = 10; // trades within ±$10 are counted as breakeven

// ── State ──────────────────────────────────────────────────────────────────
let winLossChart = null;
let pnlChart     = null;
let refreshTimeout  = null;
let countdownHandle = null;
let isLoading = false;

// Calendar navigation state
let calData        = {};
let calTradesByDay = {};
let calViewYear    = new Date().getFullYear();
let calViewMonth   = new Date().getMonth();
let calFirstLoad   = true;  // prevents auto-refresh from resetting the user's selected month

// ── Helpers ────────────────────────────────────────────────────────────────
// Short dollar format for calendar cells (no cents, abbreviates ≥$1k)
function fmtCal(val) {
  if (val === null || val === undefined) return '';
  const n = Number(val);
  const abs = Math.abs(n);
  const s = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}k` : `$${Math.round(abs)}`;
  return n >= 0 ? `+${s}` : `-${s}`;
}

function fmt(val, decimals = 2) {
  if (val === null || val === undefined || val === Infinity || val === -Infinity) return '—';
  const n = Number(val);
  if (isNaN(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  return n >= 0 ? `+$${abs}` : `-$${abs}`;
}

function pct(val) {
  if (val === null || val === undefined) return '—';
  return `${Number(val).toFixed(1)}%`;
}

function colorClass(val) {
  const n = Number(val);
  if (n > 0) return 'green';
  if (n < 0) return 'red';
  return 'muted';
}

function setEl(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) el.className = `stat-value ${cls}`;
}

function formatDate(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Status / Error UI ──────────────────────────────────────────────────────
function setStatus(state) {
  const dot = document.getElementById('statusDot');
  if (dot) dot.className = `status-dot ${state}`;
}

function showError(msg) {
  const banner = document.getElementById('errorBanner');
  const text   = document.getElementById('errorText');
  if (banner) banner.classList.add('visible');
  if (text) text.textContent = msg;
}

function hideError() {
  const banner = document.getElementById('errorBanner');
  if (banner) banner.classList.remove('visible');
}

function setRefreshBtnLoading(loading) {
  const btn = document.getElementById('refreshBtn');
  if (btn) btn.classList.toggle('loading', loading);
}

// ── Countdown ──────────────────────────────────────────────────────────────
function startCountdown() {
  if (countdownHandle) clearInterval(countdownHandle);
  let secs = REFRESH_INTERVAL;
  const el = document.getElementById('countdown');
  const update = () => { if (el) el.textContent = secs; };
  update();
  countdownHandle = setInterval(() => {
    secs = Math.max(0, secs - 1);
    update();
  }, 1000);
}

// ── Render: Stats ──────────────────────────────────────────────────────────
function renderStats(s) {
  setEl('statTotalPnl',    fmt(s.totalPnl),     colorClass(s.totalPnl));
  setEl('statWinRate',     pct(s.winRate),       s.winRate >= 50 ? 'green' : s.winRate > 0 ? 'neutral' : 'red');
  setEl('statTotalTrades', s.totalTrades || 0,  'neutral');
  setEl('statBest',        fmt(s.bestTrade),     colorClass(s.bestTrade));
  setEl('statWorst',       fmt(s.worstTrade),    colorClass(s.worstTrade));
  setEl('statWins',        s.wins || 0,          'green');
  setEl('statLosses',      s.losses || 0,        'red');
  setEl('statAvgWin',      fmt(s.avgWin),        colorClass(s.avgWin));
  setEl('statAvgLoss',     fmt(s.avgLoss),       colorClass(s.avgLoss));

  // Donut center label
  const pctEl = document.getElementById('donutPct');
  if (pctEl) {
    pctEl.textContent = pct(s.winRate);
    pctEl.style.color = s.winRate >= 50 ? 'var(--green)' : 'var(--red)';
  }
}

// ── Render: Calendar ───────────────────────────────────────────────────────
function renderCalendar(dailyPnl, dailyTrades) {
  calData        = dailyPnl    || {};
  calTradesByDay = dailyTrades || {};

  // On first load only: default to the current month.
  // Subsequent auto-refreshes leave the view wherever the user navigated.
  if (calFirstLoad) {
    calFirstLoad = false;
    const now = new Date();
    calViewYear  = now.getFullYear();
    calViewMonth = now.getMonth();
  }

  drawCalendarMonth();
}

function drawCalendarMonth() {
  const container = document.getElementById('calendar');
  if (!container) return;

  const today    = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const values   = Object.values(calData);
  const maxAbs   = values.length ? Math.max(...values.map(Math.abs), 1) : 1;

  const year  = calViewYear;
  const month = calViewMonth;

  // Update month label in the nav bar
  const label = document.getElementById('calMonthLabel');
  if (label) {
    label.textContent = new Date(year, month, 1)
      .toLocaleString('default', { month: 'long', year: 'numeric' });
  }

  // Disable "next" when already on current month
  const nextBtn = document.getElementById('calNextBtn');
  if (nextBtn) {
    const atCurrent = year === today.getFullYear() && month === today.getMonth();
    nextBtn.disabled = atCurrent;
    nextBtn.classList.toggle('cal-nav-disabled', atCurrent);
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow    = new Date(year, month, 1).getDay();

  const grid = document.createElement('div');
  grid.className = 'cal-grid fade-in';

  // Day-of-week headers
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
    const h = document.createElement('div');
    h.className = 'cal-header';
    h.textContent = d;
    grid.appendChild(h);
  });

  // Empty leading cells
  for (let i = 0; i < firstDow; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-day empty-day';
    grid.appendChild(blank);
  }

  // Day cells
  for (let day = 1; day <= daysInMonth; day++) {
    const mm  = String(month + 1).padStart(2, '0');
    const dd  = String(day).padStart(2, '0');
    const key = `${year}-${mm}-${dd}`;
    const pnl = calData[key];
    const isFuture = key > todayStr;

    const cell = document.createElement('div');
    cell.className = 'cal-day' + (isFuture ? ' future' : '');

    // Three fixed slots: top (day number), middle (PnL), bottom (trade count)
    const numSpan    = document.createElement('span');
    const pnlSpan    = document.createElement('span');
    const tradesSpan = document.createElement('span');
    numSpan.className    = 'cal-day-num';
    pnlSpan.className    = 'cal-pnl';
    tradesSpan.className = 'cal-trades';
    numSpan.textContent  = day;

    if (pnl !== undefined && !isFuture) {
      const isBreakeven = Math.abs(pnl) <= BREAKEVEN_THRESHOLD;
      const tc = calTradesByDay[key];

      if (isBreakeven) {
        cell.style.backgroundColor = 'rgba(59, 130, 246, 0.22)';
        cell.style.borderColor     = 'rgba(59, 130, 246, 0.40)';
        pnlSpan.style.color        = '#93c5fd';
        tradesSpan.style.color     = 'rgba(147, 197, 253, 0.65)';
      } else {
        const ratio   = Math.min(Math.abs(pnl) / maxAbs, 1);
        const alpha   = 0.20 + ratio * 0.70;
        const isGreen = pnl > 0;
        const bright  = alpha > 0.55;

        cell.style.backgroundColor = isGreen
          ? `rgba(0, 200, 83, ${alpha})`
          : `rgba(255, 61, 61, ${alpha})`;
        cell.style.borderColor = isGreen
          ? `rgba(0, 200, 83, ${Math.min(alpha + 0.12, 0.55)})`
          : `rgba(255, 61, 61, ${Math.min(alpha + 0.12, 0.55)})`;
        pnlSpan.style.color    = bright ? '#ffffff' : (isGreen ? 'var(--green)' : 'var(--red)');
        tradesSpan.style.color = bright ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.40)';
      }

      pnlSpan.textContent    = fmtCal(pnl);
      tradesSpan.textContent = tc ? (tc === 1 ? '1 trade' : `${tc} trades`) : '';
      cell.title = `${key}: ${fmt(pnl)}${tc ? ` · ${tc} trade${tc !== 1 ? 's' : ''}` : ''}`;
    }

    cell.appendChild(numSpan);
    cell.appendChild(pnlSpan);
    cell.appendChild(tradesSpan);
    grid.appendChild(cell);
  }

  container.innerHTML = '';
  container.appendChild(grid);
}

function calNavPrev() {
  calViewMonth--;
  if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
  drawCalendarMonth();
}

function calNavNext() {
  const now = new Date();
  if (calViewYear === now.getFullYear() && calViewMonth === now.getMonth()) return;
  calViewMonth++;
  if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
  drawCalendarMonth();
}

// ── Render: Charts ─────────────────────────────────────────────────────────
const CHART_DEFAULTS = {
  color: '#666',
  font: { family: "'Inter', system-ui, sans-serif", size: 11 }
};

function renderWinLossChart(stats) {
  const ctx = document.getElementById('winLossChart');
  if (!ctx) return;
  if (winLossChart) { winLossChart.destroy(); winLossChart = null; }

  const wins   = stats.wins   || 0;
  const losses = stats.losses || 0;
  const be     = stats.breakeven || 0;
  const total  = wins + losses + be;

  winLossChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Wins', 'Losses', 'Breakeven'],
      datasets: [{
        data: total > 0 ? [wins, losses, be] : [1, 0, 0],
        backgroundColor: total > 0
          ? ['#00c853', '#ff3d3d', '#2a2a3a']
          : ['#1e1e2e'],
        borderWidth: 0,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      animation: { duration: 400 },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#6b7280',
            padding: 10,
            font: { size: 11 },
            boxWidth: 10,
            boxHeight: 10,
            usePointStyle: true,
            pointStyle: 'rect'
          }
        },
        tooltip: {
          backgroundColor: '#111118',
          borderColor: '#1e1e2e',
          borderWidth: 1,
          titleColor: '#9ca3af',
          bodyColor: '#e8eaf0',
          callbacks: {
            label: ctx => `  ${ctx.label}: ${ctx.parsed}`
          }
        }
      }
    }
  });
}

function renderPnlChart(dailyPnl) {
  const ctx = document.getElementById('pnlChart');
  if (!ctx) return;
  if (pnlChart) { pnlChart.destroy(); pnlChart = null; }

  const sorted = Object.entries(dailyPnl || {})
    .sort(([a], [b]) => a.localeCompare(b));

  const labels = [];
  const values = [];
  let cumulative = 0;
  for (const [date, pnl] of sorted) {
    cumulative += pnl;
    labels.push(date);
    values.push(Math.round(cumulative * 100) / 100);
  }

  if (labels.length === 0) {
    labels.push('No data');
    values.push(0);
  }

  const finalVal  = values[values.length - 1] || 0;
  const lineColor = finalVal >= 0 ? '#00c853' : '#ff3d3d';
  const fillColor = finalVal >= 0 ? 'rgba(0,200,83,0.08)' : 'rgba(255,61,61,0.08)';

  pnlChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative P&L',
        data: values,
        borderColor: lineColor,
        backgroundColor: fillColor,
        fill: true,
        tension: 0.35,
        pointRadius: labels.length > 40 ? 0 : 3,
        pointHoverRadius: 5,
        pointBackgroundColor: lineColor,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#111118',
          borderColor: '#1e1e2e',
          borderWidth: 1,
          titleColor: '#9ca3af',
          bodyColor: '#e8eaf0',
          callbacks: {
            label: ctx => `  Cumulative: ${fmt(ctx.parsed.y)}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#4b5563', maxTicksLimit: 7, font: { size: 10 } },
          grid:  { color: 'rgba(255,255,255,0.04)' }
        },
        y: {
          ticks: {
            color: '#4b5563',
            font: { size: 10 },
            callback: v => {
              const abs = Math.abs(v);
              const s = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}k` : `$${abs}`;
              return v < 0 ? `-${s}` : `+${s}`;
            }
          },
          grid: { color: 'rgba(255,255,255,0.04)' }
        }
      }
    }
  });
}

// ── Render: Positions ──────────────────────────────────────────────────────
function renderPositions(positions) {
  const tbody = document.getElementById('positionsBody');
  const count = document.getElementById('posCount');
  if (!tbody) return;
  if (count) count.textContent = positions.length;

  if (!positions.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No open positions</td></tr>';
    return;
  }

  tbody.innerHTML = positions.map(p => `
    <tr class="fade-in">
      <td class="symbol">${escHtml(p.symbol)}</td>
      <td><span class="badge-side ${p.side.toLowerCase()}">${escHtml(p.side)}</span></td>
      <td>${p.qty}</td>
      <td class="${colorClass(p.openPnl)}">${fmt(p.openPnl)}</td>
    </tr>
  `).join('');
}

// ── Render: Trades ─────────────────────────────────────────────────────────
function renderTrades(trades) {
  const tbody = document.getElementById('tradesBody');
  const count = document.getElementById('tradesCount');
  if (!tbody) return;
  if (count) count.textContent = trades.length;

  if (!trades.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No trades found</td></tr>';
    return;
  }

  tbody.innerHTML = trades.map(t => `
    <tr class="fade-in">
      <td>${escHtml(formatDate(t.timestamp))}</td>
      <td class="time">${escHtml(formatTime(t.timestamp))}</td>
      <td class="symbol">${escHtml(t.symbol)}</td>
      <td>${t.qty}</td>
      <td class="${colorClass(t.pnl)}">${fmt(t.pnl)}</td>
    </tr>
  `).join('');
}

// ── XSS guard ─────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Main Fetch ─────────────────────────────────────────────────────────────
async function fetchDashboard() {
  if (isLoading) return;
  isLoading = true;
  setStatus('loading');
  setRefreshBtnLoading(true);

  try {
    const res  = await fetch('/api/dashboard');
    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Failed to load dashboard data.');
      setStatus('error');
      return;
    }

    hideError();

    renderStats(data.stats);
    renderCalendar(data.stats.dailyPnl || {});
    renderWinLossChart(data.stats);
    renderPnlChart(data.stats.dailyPnl || {});
    renderPositions(data.openPositions || []);
    renderTrades(data.recentTrades || []);

    // Header info
    const accEl = document.getElementById('accountName');
    if (accEl && data.account?.name) accEl.textContent = data.account.name;

    // Env badge
    const env = data.env || 'demo';
    const badge = document.getElementById('envBadge');
    const footerEnv = document.getElementById('footerEnv');
    if (badge) { badge.textContent = env.toUpperCase(); badge.className = `env-badge ${env}`; }
    if (footerEnv) footerEnv.textContent = env;

    setStatus('ok');
    startCountdown();

  } catch (err) {
    showError('Cannot reach the dashboard server. Is it running?');
    setStatus('error');
    console.error('[dashboard]', err);
  } finally {
    isLoading = false;
    setRefreshBtnLoading(false);
  }
}

function scheduleNext() {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(async () => {
    await fetchDashboard();
    scheduleNext();
  }, REFRESH_INTERVAL * 1000);
}

function manualRefresh() {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  if (countdownHandle) clearInterval(countdownHandle);
  fetchDashboard().then(scheduleNext);
}

// ── Boot ───────────────────────────────────────────────────────────────────
(async function init() {
  Chart.defaults.color = CHART_DEFAULTS.color;
  Chart.defaults.font  = CHART_DEFAULTS.font;

  await fetchDashboard();
  scheduleNext();
})();
