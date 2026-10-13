// integrations/square/auth/oauth.js
const crypto = require('crypto');
const axios = require('axios');
const { saveTokens, getTokensByMerchant } = require('./tokenStore');
const { startInitialSync } = require('../sync/initialSync');

function getSquareBase() {
  return process.env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

const REQUIRED_SCOPES = [
  'MERCHANT_PROFILE_READ',
  'PAYMENTS_READ',
  'ORDERS_READ',
  'CUSTOMERS_READ',
  'CUSTOMERS_WRITE',
  'ITEMS_READ',

  'INVENTORY_READ',
].join(' ');

const stateStore = new Map();

function cleanupStates() {
  const now = Date.now();
  for (const [k, v] of stateStore) if (now > v.expiresAt) stateStore.delete(k);
}

// POST /integrations/square/connect (authenticateToken)
// The merchant is the logged-in user. Returns the Square consent URL as JSON;
// the frontend navigates to it. The one-time state ties the callback back to
// this user, so nobody can attach a Square account to someone else's id.
function handleConnectRequest(req, res) {
  cleanupStates();
  const merchantId = String(req.user.userId);

  const state = crypto.randomBytes(32).toString('hex');
  stateStore.set(state, { merchantId, expiresAt: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: process.env.SQUARE_APP_ID,
    scope: REQUIRED_SCOPES,
    session: 'false',
    state,
    redirect_uri: process.env.SQUARE_REDIRECT_URI,
  });

  res.json({ success: true, url: `${getSquareBase()}/oauth2/authorize?${params}` });
}

async function handleOAuthCallback(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    console.warn('Square OAuth denied by merchant', { error });
    return res.redirect('https://aervoapp.com/dashboard/square?square=denied');
  }

  const stateData = stateStore.get(state);
  if (!stateData || Date.now() > stateData.expiresAt) {
    console.warn('Square OAuth invalid or expired state');
    return res.status(400).json({ error: 'Invalid or expired state parameter' });
  }

  const { merchantId } = stateData;
  stateStore.delete(state);

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

    startInitialSync({ merchantId, squareMerchantId, accessToken: access_token })
      .catch((err) =>
        console.error('Initial Square sync failed', { merchantId, error: err.message })
      );

    res.redirect('https://aervoapp.com/dashboard/square?connected=1');

  } catch (err) {
    console.error('Square OAuth token exchange failed', {
      merchantId,
      status: err.response?.status,
      error: err.response?.data || err.message,
    });

    res.redirect('https://aervoapp.com/dashboard/square?square=error');
  }
}

async function refreshAccessToken(merchantId) {
  const stored = await getTokensByMerchant(merchantId);

  if (!stored?.refreshToken) {
    throw new Error(`No refresh token found for merchant ${merchantId}`);
  }

  const response = await axios.post(
    `${getSquareBase()}/oauth2/token`,
    {
      client_id: process.env.SQUARE_APP_ID,
      client_secret: process.env.SQUARE_APP_SECRET,
      refresh_token: stored.refreshToken,
      grant_type: 'refresh_token',
    },
    {
      headers: { 'Content-Type': 'application/json', 'Square-Version': '2024-01-18' },
    }
  );

  const { access_token, refresh_token, expires_at } = response.data;

  await saveTokens({
    ...stored,
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: new Date(expires_at),
  });

  console.log('Square access token refreshed', { merchantId });
  return access_token;
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

module.exports = { handleConnectRequest, handleOAuthCallback, refreshAccessToken, revokeAccessToken };