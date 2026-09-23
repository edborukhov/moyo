// Per-user Plaid access token storage — replaces the old single-file access_token.json.
// Tokens are encrypted at rest (see crypto.js) and scoped to the requesting user only.

const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

function saveAccessToken(userId, accessToken, itemId) {
  const encrypted = encrypt(accessToken);
  db.prepare(`
    INSERT INTO plaid_items (user_id, item_id, access_token_encrypted)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET access_token_encrypted = excluded.access_token_encrypted
  `).run(userId, itemId, encrypted);
}

// For now Moyo testers connect one bank item each; this returns the most recent one.
function loadAccessToken(userId) {
  const row = db.prepare(
    'SELECT item_id, access_token_encrypted FROM plaid_items WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(userId);
  if (!row) return null;
  return {
    item_id: row.item_id,
    access_token: decrypt(row.access_token_encrypted),
  };
}

function hasConnectedBank(userId) {
  const row = db.prepare('SELECT 1 FROM plaid_items WHERE user_id = ? LIMIT 1').get(userId);
  return !!row;
}

module.exports = { saveAccessToken, loadAccessToken, hasConnectedBank };
