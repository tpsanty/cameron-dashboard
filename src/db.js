'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.match(/localhost|127\.0\.0\.1/)
    ? { rejectUnauthorized: false }
    : false
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fills (
      id          TEXT PRIMARY KEY,
      contract_id TEXT,
      action      TEXT,
      qty         DOUBLE PRECISION,
      price       DOUBLE PRECISION,
      timestamp   TEXT,
      raw_json    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_fills_timestamp ON fills (timestamp);
  `);
}

async function saveFills(fills) {
  const valid = fills.filter(f => f.id != null);
  if (valid.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const f of valid) {
      await client.query(
        `INSERT INTO fills (id, contract_id, action, qty, price, timestamp, raw_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           contract_id = EXCLUDED.contract_id,
           action      = EXCLUDED.action,
           qty         = EXCLUDED.qty,
           price       = EXCLUDED.price,
           timestamp   = EXCLUDED.timestamp,
           raw_json    = EXCLUDED.raw_json`,
        [
          String(f.id),
          f.contractId != null ? String(f.contractId) : null,
          f.action     || null,
          f.qty        ?? null,
          f.price      ?? null,
          f.timestamp  || null,
          JSON.stringify(f)
        ]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function loadFills() {
  const result = await pool.query('SELECT raw_json FROM fills ORDER BY timestamp ASC');
  return result.rows.map(r => JSON.parse(r.raw_json));
}

async function fillCount() {
  const result = await pool.query('SELECT COUNT(*) AS n FROM fills');
  return parseInt(result.rows[0].n, 10);
}

async function fillDateRange() {
  const result = await pool.query(
    'SELECT MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM fills WHERE timestamp IS NOT NULL'
  );
  const r = result.rows[0];
  return { oldest: r.oldest || null, newest: r.newest || null };
}

module.exports = { init, saveFills, loadFills, fillCount, fillDateRange };
