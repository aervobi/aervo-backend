const { pool } = require('../../../db');
const crypto = require('crypto');

const ENCRYPTION_KEY = Buffer.from(
  process.env.AERVO_API_SECRET || 'default-dev-key-32-bytes-long!!',
  'utf8'
).subarray(0, 32);

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(encoded) {
  const [ivHex, authTagHex, encryptedHex] = encoded.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function saveTokens({ aervMerchantId, squareMerchantId, accessToken, refreshToken, expiresAt, tokenType = 'bearer', scopes = '' }) {
  const accessEnc = encrypt(accessToken);
  const refreshEnc = encrypt(refreshToken);

  await pool.query(
    `INSERT INTO square_connections
       (aervo_merchant_id, square_merchant_id, access_token_enc, refresh_token_enc,
        expires_at, token_type, scopes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (aervo_merchant_id) DO UPDATE SET
       square_merchant_id = EXCLUDED.square_merchant_id,
       access_token_enc   = EXCLUDED.access_token_enc,
       refresh_token_enc  = EXCLUDED.refresh_token_enc,
       expires_at         = EXCLUDED.expires_at,
       token_type         = EXCLUDED.token_type,
       scopes             = EXCLUDED.scopes,
       updated_at         = NOW()`,
    [aervMerchantId, squareMerchantId, accessEnc, refreshEnc, expiresAt, tokenType, scopes]
  );
}

async function getTokensByMerchant(aervMerchantId) {
  const result = await pool.query(
    `SELECT * FROM square_connections WHERE aervo_merchant_id = $1`,
    [aervMerchantId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    aervMerchantId: row.aervo_merchant_id,
    squareMerchantId: row.square_merchant_id,
    accessToken: decrypt(row.access_token_enc),
    refreshToken: decrypt(row.refresh_token_enc),
    expiresAt: row.expires_at,
    tokenType: row.token_type,
    scopes: row.scopes,
    connectedAt: row.connected_at,
  };
}

function isTokenExpired(expiresAt) {
  return new Date(expiresAt) < new Date(Date.now() + 5 * 60 * 1000);
}

async function deleteTokens(aervMerchantId) {
  await pool.query(
    `DELETE FROM square_connections WHERE aervo_merchant_id = $1`,
    [aervMerchantId]
  );
}

module.exports = { saveTokens, getTokensByMerchant, isTokenExpired, deleteTokens };