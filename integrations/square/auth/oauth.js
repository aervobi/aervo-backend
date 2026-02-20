// integrations/square/auth/oauth.js
const crypto = require('crypto');
const axios = require('axios');
const { saveTokens, getTokensByMerchant } = require('./tokenStore');
const { startInitialSync } = require('../sync/initialSync');

const SQUARE_OAUTH_BASE =
  process.env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

const REQUIRED_SCOPES = [
  'MERCHANT_PROFILE_READ',
  'PAYMENTS_READ',
  'ORDERS_READ',
  'CUSTOMERS_READ',
  'CUSTOMERS_WRITE',
  'ITEMS_READ',
  'APPOINTMENTS_READ',
  'INVENTORY_READ',
].join(' ');

const stateStore = new Map();

function handleConnectRequest(req, res) {
  const { merchantId } = req.query;

  if (!merchantId) {
    return res.status(400).json({ error: 'merchantId is required' });
  }

  const state = crypto.randomBytes(32).toString('hex');
  stateStore.set(state, { merchantId, expiresAt: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: process.env.SQUARE_APP_ID,
    scope: REQUIRED_SCOPES,
    session: 'false',
    state,
  });

  const authUrl = `${SQUARE_OAUTH_BASE}/oauth2/authorize?${params}`;
  console.log('Redirecting merchant to Square OAuth:', authUrl);
  res.redirect(authUrl);
}

async function handleOAuthCallback(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    console.warn('Square OAuth denied by merchant', { error });
    return res.redirect(
      `${process.env.AERVO_APP_URL}/dashboard?square_connect=denied`
    );
  }

  const stateData = stateStore.get(state);
  if (!stateData || Date.now() > stateData.expiresAt) {
    console.warn('Square OAuth invalid or expired state', { state });
    return res.status(400).json({ error: 'Invalid or expired state parameter' });
  }

  const { merchantId } = stateData;
  stateStore.delete(state);

  try {
    const tokenResponse = await axios.post(
      `${SQUARE_OAUTH_BASE}/oauth2/token`,
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

    res.redirect(
      `${process.env.AERVO_APP_URL}/dashboard?square_connect=success&sync=started`
    );
  } catch (err) {
    console.error('Square OAuth token exchange failed', {
      merchantId,
      status: err.response?.status,
      error: err.response?.data || err.message,
    });

    res.redirect(
      `${process.env.AERVO_APP_URL}/dashboard?square_connect=error`
    );
  }
}

async function refreshAccessToken(merchantId) {
  const stored = await getTokensByMerchant(merchantId);

  if (!stored?.refreshToken) {
    throw new Error(`No refresh token found for merchant ${merchantId}`);
  }

  const response = await axios.post(
    `${SQUARE_OAUTH_BASE}/oauth2/token`,
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

module.exports = { handleConnectRequest, handleOAuthCallback, refreshAccessToken };