'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS draws (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'revealed')),
    commitment  TEXT NOT NULL,
    seed        TEXT NOT NULL,
    nonce       TEXT,
    candidates  TEXT NOT NULL,
    draw_count  INTEGER NOT NULL,
    result      TEXT,
    created_at  TEXT NOT NULL,
    revealed_at TEXT
  );
`;

// Opens (creating if needed) the SQLite database and ensures the schema exists.
function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDatabase };
