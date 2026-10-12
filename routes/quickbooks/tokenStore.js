// ============================================================
// Aervo QuickBooks Integration — Token Store
// File: routes/quickbooks/tokenStore.js
// Shared by routes/quickbooks/auth.js and scripts/sync-quickbooks.js
// so both use the same encryption and refresh logic — same role as
// integrations/square/auth/tokenStore.js plays for Square.
// ============================================================

const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('../../db');

const QB_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET;
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64')}`;
}

// ---- token encryption at rest (AES-256-GCM) ----
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

async function saveTokens({
  userId,
  realmId,
  accessToken,
  refreshToken,
  accessTokenExpiresAt,
  refreshTokenExpiresAt,
  environment,
}) {
  await pool.query(
    `INSERT INTO quickbooks_connections
       (user_id, realm_id, access_token_enc, refresh_token_enc,
        access_token_expires_at, refresh_token_expires_at, environment, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       realm_id                 = EXCLUDED.realm_id,
       access_token_enc         = EXCLUDED.access_token_enc,
       refresh_token_enc        = EXCLUDED.refresh_token_enc,
       access_token_expires_at  = EXCLUDED.access_token_expires_at,
       refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
       environment              = EXCLUDED.environment,
       updated_at               = NOW()`,
    [
      userId,
      realmId,
      encrypt(accessToken),
      encrypt(refreshToken),
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      environment,
    ]
  );
}

async function getConnection(userId) {
  const result = await pool.query(
    `SELECT * FROM quickbooks_connections WHERE user_id = $1`,
    [userId]
  );
  if (!result.rows.length) return null;

  const row = result.rows[0];
  return {
    userId: row.user_id,
    realmId: row.realm_id,
    accessToken: decrypt(row.access_token_enc),
    refreshToken: decrypt(row.refresh_token_enc),
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    environment: row.environment,
    connectedAt: row.connected_at,
  };
}

async function getAllConnectedUserIds() {
  const result = await pool.query(`SELECT user_id FROM quickbooks_connections ORDER BY user_id`);
  return result.rows.map((r) => r.user_id);
}

function isExpired(expiresAt) {
  return new Date(expiresAt) < new Date(Date.now() + 5 * 60 * 1000);
}

async function refreshAccessToken(userId) {
  const conn = await getConnection(userId);
  if (!conn) throw new Error(`No QuickBooks connection for user ${userId}`);

  const response = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: conn.refreshToken,
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: basicAuthHeader(),
      },
    }
  );

  const { access_token, refresh_token, expires_in, x_refresh_token_expires_in } = response.data;
  const accessTokenExpiresAt = new Date(Date.now() + expires_in * 1000);
  const refreshTokenExpiresAt = new Date(Date.now() + x_refresh_token_expires_in * 1000);

  await saveTokens({
    userId,
    realmId: conn.realmId,
    accessToken: access_token,
    refreshToken: refresh_token,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    environment: conn.environment,
  });

  return { accessToken: access_token, realmId: conn.realmId, environment: conn.environment };
}

// Returns a connection with a guaranteed-valid access token, refreshing
// first if the current one is expired (or about to expire).
async function getValidConnection(userId) {
  const conn = await getConnection(userId);
  if (!conn) return null;
  if (!isExpired(conn.accessTokenExpiresAt)) return conn;

  const refreshed = await refreshAccessToken(userId);
  return { ...conn, accessToken: refreshed.accessToken };
}

async function deleteConnection(userId) {
  await pool.query(`DELETE FROM quickbooks_connections WHERE user_id = $1`, [userId]);
}

async function markSyncStatus(userId, status, errorMessage = null) {
  await pool.query(
    `UPDATE quickbooks_connections
     SET sync_status = $1, sync_completed_at = NOW(), sync_error = $2
     WHERE user_id = $3`,
    [status, errorMessage, userId]
  );
}

module.exports = {
  encrypt,
  decrypt,
  saveTokens,
  getConnection,
  getAllConnectedUserIds,
  getValidConnection,
  refreshAccessToken,
  deleteConnection,
  markSyncStatus,
  isExpired,
};
