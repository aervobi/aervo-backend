// ============================================================
// Aervo QuickBooks Integration — OAuth Routes
// File: routes/quickbooks/auth.js
// See quickbooks-integration-spec.md for full context.
// ============================================================

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

module.exports = function (pool, authenticateToken) {
  const router = express.Router();

  const QB_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID;
  const QB_CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET;
  const QB_REDIRECT_URI = process.env.QUICKBOOKS_REDIRECT_URI;
  const QB_ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox';
  const APP_URL = process.env.APP_URL || 'https://aervoapp.com';

  if (!QB_CLIENT_ID || !QB_CLIENT_SECRET || !QB_REDIRECT_URI) {
    console.warn(
      '⚠️ Missing one of QUICKBOOKS_CLIENT_ID / QUICKBOOKS_CLIENT_SECRET / QUICKBOOKS_REDIRECT_URI in env.'
    );
  }

  // Intuit's OAuth server is the same for sandbox and production —
  // only the Accounting API base URL (used later by the sync job)
  // differs by environment.
  const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
  const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
  const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
  const SCOPE = 'com.intuit.quickbooks.accounting';

  function basicAuthHeader() {
    return `Basic ${Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64')}`;
  }

  // ---- CSRF state store ----
  // Same short-lived in-memory pattern as the Square integration
  // (integrations/square/auth/oauth.js): connect() stashes which
  // Aervo user initiated the flow, keyed by a random state, and
  // callback() looks it up — Intuit's redirect carries no auth header.
  const stateStore = new Map();
  const STATE_TTL_MS = 10 * 60 * 1000;

  function cleanupExpiredStates() {
    const now = Date.now();
    for (const [state, data] of stateStore) {
      if (now > data.expiresAt) stateStore.delete(state);
    }
  }

  // ---- token encryption at rest ----
  // Same AES-256-GCM scheme as integrations/square/auth/tokenStore.js.
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

  // ============================================================
  // GET /api/quickbooks/connect
  // Requires a valid Aervo session (Authorization header). A plain
  // <a href> can't carry that header on a top-level navigation, so
  // this returns the Intuit consent URL as JSON — the frontend calls
  // it with an authenticated fetch, then does window.location = url.
  // ============================================================
  router.get('/api/quickbooks/connect', authenticateToken, (req, res) => {
    if (!QB_CLIENT_ID || !QB_REDIRECT_URI) {
      return res
        .status(500)
        .json({ success: false, message: 'QuickBooks integration is not configured' });
    }

    cleanupExpiredStates();

    const state = crypto.randomBytes(32).toString('hex');
    stateStore.set(state, { userId: req.user.userId, expiresAt: Date.now() + STATE_TTL_MS });

    const params = new URLSearchParams({
      client_id: QB_CLIENT_ID,
      redirect_uri: QB_REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
      state,
    });

    res.json({ success: true, url: `${AUTH_BASE}?${params}` });
  });

  // ============================================================
  // GET /api/quickbooks/callback
  // Intuit redirects the user's browser here after consent.
  // ============================================================
  router.get('/api/quickbooks/callback', async (req, res) => {
    const { code, state, realmId, error } = req.query;

    if (error) {
      console.warn('QuickBooks OAuth denied by user', { error });
      return res.redirect(`${APP_URL}/settings?quickbooks=denied`);
    }

    const stateData = stateStore.get(state);
    if (!stateData || Date.now() > stateData.expiresAt) {
      console.warn('QuickBooks OAuth invalid or expired state', { state });
      return res.status(400).json({ success: false, message: 'Invalid or expired state parameter' });
    }
    stateStore.delete(state);

    const { userId } = stateData;

    try {
      const tokenResponse = await axios.post(
        TOKEN_URL,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: QB_REDIRECT_URI,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Authorization: basicAuthHeader(),
          },
        }
      );

      const { access_token, refresh_token, expires_in, x_refresh_token_expires_in } =
        tokenResponse.data;

      const accessTokenExpiresAt = new Date(Date.now() + expires_in * 1000);
      const refreshTokenExpiresAt = new Date(Date.now() + x_refresh_token_expires_in * 1000);

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
           sync_status              = NULL,
           sync_error               = NULL,
           updated_at               = NOW()`,
        [
          userId,
          realmId,
          encrypt(access_token),
          encrypt(refresh_token),
          accessTokenExpiresAt,
          refreshTokenExpiresAt,
          QB_ENVIRONMENT,
        ]
      );

      console.log('QuickBooks connected', { userId, realmId });
      res.redirect(`${APP_URL}/settings?quickbooks=connected`);
    } catch (err) {
      console.error('QuickBooks OAuth token exchange failed', {
        userId,
        status: err.response?.status,
        error: err.response?.data || err.message,
      });
      res.redirect(`${APP_URL}/settings?quickbooks=error`);
    }
  });

  // ============================================================
  // GET /api/quickbooks/status
  // Lets the frontend show connected/not-connected state — not in
  // the original spec's route list, added because the integrations
  // page has no other way to know whether this user has a connection.
  // ============================================================
  router.get('/api/quickbooks/status', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT realm_id, environment, connected_at, access_token_expires_at
         FROM quickbooks_connections WHERE user_id = $1`,
        [req.user.userId]
      );

      if (!result.rows.length) {
        return res.json({ success: true, connected: false });
      }

      const row = result.rows[0];
      res.json({
        success: true,
        connected: true,
        realmId: row.realm_id,
        environment: row.environment,
        connectedAt: row.connected_at,
        tokenExpiresAt: row.access_token_expires_at,
      });
    } catch (err) {
      console.error('Error fetching QuickBooks status', { userId: req.user.userId, error: err.message });
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  // ============================================================
  // POST /api/quickbooks/disconnect
  // Revokes the refresh token with Intuit, then clears the stored
  // connection regardless of whether the revoke call succeeds.
  // ============================================================
  router.post('/api/quickbooks/disconnect', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    try {
      const result = await pool.query(
        `SELECT refresh_token_enc FROM quickbooks_connections WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length) {
        try {
          const refreshToken = decrypt(result.rows[0].refresh_token_enc);
          await axios.post(
            REVOKE_URL,
            { token: refreshToken },
            {
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: basicAuthHeader(),
              },
            }
          );
        } catch (revokeErr) {
          console.warn('QuickBooks token revoke failed, clearing local record anyway', {
            userId,
            error: revokeErr.response?.data || revokeErr.message,
          });
        }
      }

      await pool.query(`DELETE FROM quickbooks_connections WHERE user_id = $1`, [userId]);

      console.log('QuickBooks disconnected', { userId });
      res.json({ success: true, message: 'QuickBooks connection removed' });
    } catch (err) {
      console.error('Error disconnecting QuickBooks', { userId, error: err.message });
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  return router;
};
