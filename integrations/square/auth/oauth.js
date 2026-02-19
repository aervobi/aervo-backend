// integrations/square/auth/oauth.js
// Handles the full Square OAuth 2.0 authorization code flow.
//
// Flow:
//   1. Merchant clicks "Connect Square" in Aervo dashboard
//   2. GET  /integrations/square/connect  → redirect to Square OAuth screen
//   3. Square redirects back to           → GET /integrations/square/callback
//   4. We exchange the code for tokens    → store in DB → begin initial sync

const crypto = require('crypto');
const axios = require('axios');
const { saveTokens, getTokensByMerchant } = require('./tokenStore');
const { startInitialSync } = require('../sync/initialSync');
const logger = require('../../../lib/logger');

// Square OAuth endpoints
const SQUARE_OAUTH_BASE =
  process.env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

// All Square permission scopes Aervo needs
const REQUIRED_SCOPES = [
  'MERCHANT_PROFILE_READ',
  'PAYMENTS_READ',
  'ORDERS_READ',
  'CUSTOMERS_READ',
  'CUSTOMERS_WRITE',        // For updating customer notes/tags from AI insights
  'ITEMS_READ',             // Catalog / Menu
  'APPOINTMENTS_READ',
  'APPOINTMENTS_WRITE',     // For rebooking nudges
  'INVENTORY_READ',
  'EMPLOYEES_READ',         // Staff performance insights
].join(' ');

// Temporary in-memory state store (use Redis in production)
const stateStore = new Map();

/**
 * Step 1: Generate the Square OAuth authorization URL and redirect the merchant.
 * We embed a `state` param to prevent CSRF attacks.
 */
function handleConnectRequest(req, res) {
  const { merchantId } = req.query; // Aervo's internal merchant ID

  if (!merchantId) {
    return res.status(400).json({ error: 'merchantId is required' });
  }

  // Generate a cryptographically random state token
  const state = crypto.randomBytes(32).toString('hex');

  // Store state → merchantId mapping (expires in 10 minutes)
  stateStore.set(state, { merchantId, expiresAt: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: process.env.SQUARE_APP_ID,
    scope: REQUIRED_SCOPES,
    session: 'false',        // Don't create a new Square session, use existing
    state,
  });

  const authUrl = `${SQUARE_OAUTH_BASE}/oauth2/authorize?${params}`;

  logger.info('Redirecting merchant to Square OAuth', { merchantId });
  res.redirect(authUrl);
}

/**
 * Step 2: Handle the OAuth callback from Square.
 * Exchange the authorization code for access + refresh tokens.
 */
async function handleOAuthCallback(req, res) {
  const { code, state, error } = req.query;

  // ── Error from Square ───────────────────────────────────────────────────────
  if (error) {
    logger.warn('Square OAuth denied by merchant', { error });
    return res.redirect(
      `${process.env.AERVO_APP_URL}/dashboard?square_connect=denied`
    );
  }

  // ── Validate state (CSRF protection) ───────────────────────────────────────
  const stateData = stateStore.get(state);
  if (!stateData || Date.now() > stateData.expiresAt) {
    logger.warn('Square OAuth invalid or expired state', { state });
    return res.status(400).json({ error: 'Invalid or expired state parameter' });
  }

  const { merchantId } = stateData;
  stateStore.delete(state); // One-time use

  // ── Exchange code for tokens ────────────────────────────────────────────────
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

    logger.info('Square OAuth tokens received', { merchantId, squareMerchantId });

    // ── Persist tokens ──────────────────────────────────────────────────────
    await saveTokens({
      aervMerchantId: merchantId,
      squareMerchantId,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: new Date(expires_at),
      tokenType: token_type,
      scopes: REQUIRED_SCOPES,
    });

    // ── Kick off initial data sync in the background ────────────────────────
    // Don't await — let it run async so the merchant gets redirected immediately
    startInitialSync({ merchantId, squareMerchantId, accessToken: access_token })
      .catch((err) =>
        logger.error('Initial Square sync failed', { merchantId, error: err.message })
      );

    // ── Redirect merchant back to Aervo dashboard ───────────────────────────
    res.redirect(
      `${process.env.AERVO_APP_URL}/dashboard?square_connect=success&sync=started`
    );
  } catch (err) {
    logger.error('Square OAuth token exchange failed', {
      merchantId,
      status: err.response?.status,
      error: err.response?.data || err.message,
    });

    res.redirect(
      `${process.env.AERVO_APP_URL}/dashboard?square_connect=error`
    );
  }
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Called automatically by the sync layer when a 401 is encountered.
 *
 * @param {string} merchantId - Aervo's internal merchant ID
 * @returns {string} New access token
 */
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

  logger.info('Square access token refreshed', { merchantId });
  return access_token;
}

module.exports = { handleConnectRequest, handleOAuthCallback, refreshAccessToken };
