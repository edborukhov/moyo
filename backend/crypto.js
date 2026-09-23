// Encrypt/decrypt Plaid access tokens at rest using AES-256-GCM.
// Key comes from ENCRYPTION_KEY in .env (32-byte hex, generated once, never rotated
// casually — rotating it makes every already-stored token undecryptable).

const crypto = require('crypto');

const KEY_HEX = process.env.ENCRYPTION_KEY;
if (!KEY_HEX || KEY_HEX.length !== 64) {
  console.warn('⚠️  ENCRYPTION_KEY missing or wrong length in .env — token encryption will fail. It must be a 64-character hex string (32 bytes).');
}
const KEY = KEY_HEX ? Buffer.from(KEY_HEX, 'hex') : null;

function encrypt(plaintext) {
  if (!KEY) throw new Error('ENCRYPTION_KEY is not configured.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together, base64, so it's one column.
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(payload) {
  if (!KEY) throw new Error('ENCRYPTION_KEY is not configured.');
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
