// integrations/square/auth/oauth.js
const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('../../../db');
const { checkSourceLimit } = require('../../../utils/planAccess');
const { saveTokens, getTokensByMerchant } = require('./tokenStore');
const { startInitialSync } = require('../sync/initialSync');

function getSquareBase() {
  return process.env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

// Read-only: Aervo never changes a seller's Square data. Appointments and team
// members feed the bookings dashboard and staffing insights.
const REQUIRED_SCOPES = [
  'MERCHANT_PROFILE_READ',
  'PAYMENTS_READ',
  'ORDERS_READ',
  'CUSTOMERS_READ',
  'ITEMS_READ',
  'INVENTORY_READ',
  'APPOINTMENTS_READ',
  'APPOINTMENTS_ALL_READ',
  'EMPLOYEES_READ',
].join(' ');

const FRONTEND = () => process.env.FRONTEND_BASE_URL || 'https://aervoapp.com';
const backToDashboard = (res, query) => res.redirect(`${FRONTEND()}/dashboard/square?${query}`);

// Sandbox app ids start with "sandbox-". Sandbox only works with Square TEST
// seller accounts (and only after launching one from the Developer Console), so
// real merchants can't connect unless the server runs with production credentials.
function configProblem() {
  const appId = process.env.SQUARE_APP_ID || '';
  const env = process.env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  if (!appId || !process.env.SQUARE_APP_SECRET || !process.env.SQUARE_REDIRECT_URI) {
    return 'SQUARE_APP_ID, SQUARE_APP_SECRET and SQUARE_REDIRECT_URI must all be set';
  }
  const appIsSandbox = appId.startsWith('sandbox-');
  if (env === 'production' && appIsSandbox) return 'SQUARE_ENVIRONMENT is production but SQUARE_APP_ID is a sandbox app id';
  if (env === 'sandbox' && !appIsSandbox) return 'SQUARE_ENVIRONMENT is sandbox but SQUARE_APP_ID is a production app id';
  return null;
}

{
  const problem = configProblem();
  const env = process.env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  if (problem) console.error(`Square OAuth misconfigured: ${problem}`);
  else if (env === 'sandbox') console.warn('Square OAuth is in SANDBOX mode: only Square test accounts can connect');
}

// One-time OAuth states live in the database, so a deploy or restart while a
// merchant is on Square's consent screen doesn't break their connection.
const STATE_MINUTES = 10;
let stateTable;
function ensureStateTable() {
  if (!stateTable) {
    stateTable = pool
      .query(
        `CREATE TABLE IF NOT EXISTS square_oauth_states (
           state_hash  TEXT PRIMARY KEY,
           merchant_id TEXT NOT NULL,
           expires_at  TIMESTAMPTZ NOT NULL
         )`
      )
      .catch((err) => {
        stateTable = null;
        throw err;
      });
  }
  return stateTable;
}
const hashState = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Returns the Aervo merchant id the state was issued to, or null. Single use.
async function consumeState(state) {
  if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) return null;
  await ensureStateTable();
  const r = await pool.query(
    `DELETE FROM square_oauth_states WHERE state_hash = $1 RETURNING merchant_id, expires_at`,
    [hashState(state)]
  );
  const row = r.rows[0];
  return row && new Date(row.expires_at) > new Date() ? row.merchant_id : null;
}

// POST /integrations/square/connect (authenticateToken)
// The merchant is the logged-in user. Returns the Square consent URL as JSON;
// the frontend navigates to it. The one-time state ties the callback back to
// this user, so nobody can attach a Square account to someone else's id.
async function handleConnectRequest(req, res) {
  const problem = configProblem();
  if (problem) {
    console.error(`Square connect refused: ${problem}`);
    return res.status(503).json({ success: false, message: 'Square connections are temporarily unavailable. Please try again later.' });
  }
  try {
    const merchantId = String(req.user.userId);
    const blocked = await checkSourceLimit(pool, req.user.userId, 'square');
    if (blocked) return res.status(403).json(blocked);
    const state = crypto.randomBytes(32).toString('hex');
    await ensureStateTable();
    await pool.query(`DELETE FROM square_oauth_states WHERE expires_at < NOW()`);
    await pool.query(
      `INSERT INTO square_oauth_states (state_hash, merchant_id, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
      [hashState(state), merchantId, String(STATE_MINUTES)]
    );

    const params = new URLSearchParams({
      client_id: process.env.SQUARE_APP_ID,
      scope: REQUIRED_SCOPES,
      session: 'false',
      state,
      redirect_uri: process.env.SQUARE_REDIRECT_URI,
    });

    res.json({ success: true, url: `${getSquareBase()}/oauth2/authorize?${params}` });
  } catch (err) {
    console.error('Square connect start failed', { error: err.message });
    res.status(500).json({ success: false, message: 'Could not start the Square connection.' });
  }
}

async function handleOAuthCallback(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    console.warn('Square OAuth denied by merchant', { error });
    return backToDashboard(res, 'square=denied');
  }

  let merchantId;
  try {
    merchantId = await consumeState(state);
  } catch (err) {
    console.error('Square OAuth state check failed', { error: err.message });
    return backToDashboard(res, 'square=error');
  }
  if (!merchantId) {
    console.warn('Square OAuth invalid or expired state');
    return backToDashboard(res, 'square=expired');
  }
  if (!code) return backToDashboard(res, 'square=error');

  try {
    const tokenResponse = await axios.post(
      `${getSquareBase()}/oauth2/token`,
      {
        client_id: process.env.SQUARE_APP_ID,
        client_secret: process.env.SQUARE_APP_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: process.env.SQUARE_REDIRECT_URI,
      },
      {
        headers: { 'Content-Type': 'application/json', 'Square-Version': '2024-01-18' },
      }
    );

    const {
      access_token,
      refresh_token,
      expires_at,
      merchant_id: squareMerchantId,
      token_type,
    } = tokenResponse.data;

    console.log('Square OAuth tokens received', { merchantId, squareMerchantId });

    await saveTokens({
      aervMerchantId: merchantId,
      squareMerchantId,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: new Date(expires_at),
      tokenType: token_type,
      scopes: REQUIRED_SCOPES,
    });

    // Tokens are saved, so the connection worked: a status hiccup must not undo that
    await setConnectionStatus(merchantId, 'syncing', null).catch((err) =>
      console.warn('Could not mark Square sync as started', { merchantId, error: err.message })
    );
    startInitialSync({ merchantId, squareMerchantId, accessToken: access_token })
      .catch((err) =>
        console.error('Initial Square sync failed', { merchantId, error: err.message })
      );

    backToDashboard(res, 'connected=1');

  } catch (err) {
    console.error('Square OAuth token exchange failed', {
      merchantId,
      status: err.response?.status,
      error: err.response?.data || err.message,
    });

    backToDashboard(res, 'square=error');
  }
}

// Square access tokens last 30 days. Refresh well before that so a missed day
// (downtime, a failed job) never leaves a seller disconnected.
const REFRESH_WITHIN_DAYS = 7;
const RECONNECT_MESSAGE = 'Square access expired or was removed. Reconnect Square to resume syncing.';

async function setConnectionStatus(merchantId, status, error) {
  await pool.query(
    `UPDATE square_connections SET sync_status = $2, sync_error = $3 WHERE aervo_merchant_id = $1`,
    [String(merchantId), status, error]
  );
}

async function refreshAccessToken(merchantId) {
  const stored = await getTokensByMerchant(merchantId);

  if (!stored?.refreshToken) {
    throw new Error(`No refresh token found for merchant ${merchantId}`);
  }

  let response;
  try {
    response = await axios.post(
      `${getSquareBase()}/oauth2/token`,
      {
        client_id: process.env.SQUARE_APP_ID,
        client_secret: process.env.SQUARE_APP_SECRET,
        refresh_token: stored.refreshToken,
        grant_type: 'refresh_token',
      },
      {
        headers: { 'Content-Type': 'application/json', 'Square-Version': '2024-01-18' },
        timeout: 15000,
      }
    );
  } catch (err) {
    const status = err.response?.status;
    // 400/401: the seller revoked access or the refresh token is no longer valid
    if (status === 400 || status === 401) {
      await setConnectionStatus(merchantId, 'reconnect_required', RECONNECT_MESSAGE);
      err.reconnectRequired = true;
    }
    throw err;
  }

  const { access_token, refresh_token, expires_at } = response.data;

  await saveTokens({
    ...stored,
    accessToken: access_token,
    refreshToken: refresh_token || stored.refreshToken, // Square may not send a new one
    expiresAt: new Date(expires_at),
  });

  console.log('Square access token refreshed', { merchantId });
  return access_token;
}

// A working access token for this merchant (refreshed first if it's close to
// expiring), or null if they never connected. Throws if Square says reconnect.
async function getValidAccessToken(merchantId) {
  const stored = await getTokensByMerchant(String(merchantId));
  if (!stored) return null;
  const msLeft = new Date(stored.expiresAt).getTime() - Date.now();
  if (msLeft > REFRESH_WITHIN_DAYS * 86400000) return stored.accessToken;
  try {
    return await refreshAccessToken(String(merchantId));
  } catch (err) {
    // A temporary failure while the old token still works: keep using it
    if (!err.reconnectRequired && msLeft > 5 * 60 * 1000) {
      console.warn('Square token refresh failed, using current token', { merchantId, error: err.message });
      return stored.accessToken;
    }
    throw err;
  }
}

// Tell Square to revoke the access token, so a disconnect really ends access
// (deleting our copy alone would leave the token valid at Square). Best effort:
// a failure is logged but never blocks the local disconnect.
async function revokeAccessToken(accessToken) {
  try {
    await axios.post(
      `${getSquareBase()}/oauth2/revoke`,
      { client_id: process.env.SQUARE_APP_ID, access_token: accessToken },
      {
        headers: {
          'Content-Type': 'application/json',
          'Square-Version': '2024-01-18',
          Authorization: `Client ${process.env.SQUARE_APP_SECRET}`,
        },
        timeout: 10000,
      }
    );
    return true;
  } catch (err) {
    console.error('Square token revoke failed', {
      status: err.response?.status,
      error: err.response?.data?.errors || err.message,
    });
    return false;
  }
}

module.exports = {
  handleConnectRequest,
  handleOAuthCallback,
  refreshAccessToken,
  getValidAccessToken,
  setConnectionStatus,
  revokeAccessToken,
  REFRESH_WITHIN_DAYS,
};