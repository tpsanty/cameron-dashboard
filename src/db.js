'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'fills.db');

// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode gives much better write performance with concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS fills (
    id          TEXT PRIMARY KEY,
    contract_id TEXT,
    action      TEXT,
    qty         REAL,
    price       REAL,
    timestamp   TEXT,
    raw_json    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_fills_timestamp
    ON fills (timestamp);
`);

// ── Prepared statements ───────────────────────────────────────────────────
const _insertFill = db.prepare(`
  INSERT OR REPLACE INTO fills
    (id, contract_id, action, qty, price, timestamp, raw_json)
  VALUES
    (@id, @contractId, @action, @qty, @price, @timestamp, @rawJson)
`);

// Wrap the loop in a transaction so 100 fills = 1 disk write, not 100
const _upsertMany = db.transaction(fills => {
  for (const f of fills) {
    if (f.id == null) continue;
    _insertFill.run({
      id:         String(f.id),
      contractId: f.contractId != null ? String(f.contractId) : null,
      action:     f.action     || null,
      qty:        f.qty        ?? null,
      price:      f.price      ?? null,
      timestamp:  f.timestamp  || null,
      rawJson:    JSON.stringify(f)
    });
  }
});

// ── Public API ────────────────────────────────────────────────────────────

function saveFills(fills) {
  _upsertMany(fills);
}

function loadFills() {
  return db
    .prepare('SELECT raw_json FROM fills ORDER BY timestamp ASC')
    .all()
    .map(r => JSON.parse(r.raw_json));
}

function fillCount() {
  return db.prepare('SELECT COUNT(*) as n FROM fills').get().n;
}

function fillDateRange() {
  const r = db
    .prepare('SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM fills WHERE timestamp IS NOT NULL')
    .get();
  return { oldest: r.oldest || null, newest: r.newest || null };
}

module.exports = { saveFills, loadFills, fillCount, fillDateRange };
