'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, '..', 'data', 'draws.db');

if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 自动建表（幂等）
db.exec(`
CREATE TABLE IF NOT EXISTS draws (
  id             TEXT PRIMARY KEY,
  status         TEXT NOT NULL CHECK (status IN ('committed', 'revealed')),
  candidates     TEXT NOT NULL,          -- 候选快照（JSON 数组，提交后不可变）
  candidate_hash TEXT NOT NULL,          -- SHA-256(候选快照)
  pick_count     INTEGER NOT NULL,
  seed           TEXT NOT NULL,          -- 揭示前绝不外泄
  commitment     TEXT NOT NULL UNIQUE,   -- SHA-256(seed)
  nonce          TEXT,                   -- 揭示时由调用方提交，仅可提交一次
  result         TEXT,                   -- 中奖顺序（JSON 数组）
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revealed_at    TEXT
);
`);

module.exports = db;
