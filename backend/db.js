// Moyo multi-user database — SQLite file, one row per user, one row per connected bank item.
// Plaid access tokens are stored encrypted (see crypto.js), never in plaintext.

const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'moyo.db');
const db = new Database(DB_FILE);
// WAL mode needs shared-memory locking that some mounted/networked filesystems don't support;
// the default rollback-journal mode is slightly slower under heavy concurrency but works everywhere.
// Revisit if this ever moves to a real server disk.

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS plaid_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    access_token_encrypted TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, item_id)
  );
`);

module.exports = db;
