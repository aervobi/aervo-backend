// integrations/square/routes.js
// Express router for all Square integration endpoints.
//
// Routes:
//   GET  /integrations/square/connect      — Start OAuth flow
//   GET  /integrations/square/callback     — OAuth callback from Square
//   POST /integrations/square/webhooks     — Receive real-time Square events
//   GET  /integrations/square/status       — Check connection + sync status
//   DELETE /integrations/square/disconnect — Disconnect a merchant's Square account

const express = require('express');
const router = express.Router();

const { handleConnectRequest, handleOAuthCallback } = require('./auth/oauth');
const { handleWebhookEvent } = require('./webhooks/webhookHandler');
const { deleteTokens, getTokensByMerchant } = require('./auth/tokenStore');
const logger = require('../../lib/logger');

// ── OAuth Flow ────────────────────────────────────────────────────────────────

// Step 1: Merchant clicks "Connect Square" — redirect to Square's OAuth screen
router.get('/connect', handleConnectRequest);

// Step 2: Square redirects back here after merchant authorizes
router.get('/callback', handleOAuthCallback);

// ── Webhooks ──────────────────────────────────────────────────────────────────
// IMPORTANT: Raw body must be available on req.rawBody for signature verification.
// Add this middleware in your main Express app BEFORE express.json():
//
//   app.use('/integrations/square/webhooks', (req, res, next) => {
//     let data = '';
//     req.on('data', chunk => data += chunk);
//     req.on('end', () => { req.rawBody = data; next(); });
//   });

router.post('/webhooks', handleWebhookEvent);

// ── Status & Management ───────────────────────────────────────────────────────

/**
 * GET /integrations/square/status?merchantId=xxx
 * Returns the connection status and last sync info for a merchant.
 */
router.get('/status', async (req, res) => {
  const { merchantId } = req.query;
  if (!merchantId) return res.status(400).json({ error: 'merchantId required' });

  try {
    const tokens = await getTokensByMerchant(merchantId);
    if (!tokens) {
      return res.json({ connected: false });
    }

    const { pool } = require('../../lib/db');

    // Get location count
    const locResult = await pool.query(
      `SELECT COUNT(*) FROM square_locations WHERE aervo_merchant_id = $1`,
      [merchantId]
    );

    // Get sync status
    const syncResult = await pool.query(
      `SELECT sync_status, sync_completed_at, sync_error FROM square_connections
       WHERE aervo_merchant_id = $1`,
      [merchantId]
    );

    const syncRow = syncResult.rows[0] || {};

    res.json({
      connected: true,
      squareMerchantId: tokens.squareMerchantId,
      connectedAt: tokens.connectedAt,
      tokenExpiresAt: tokens.expiresAt,
      locationCount: parseInt(locResult.rows[0].count),
      sync: {
        status: syncRow.sync_status,
        completedAt: syncRow.sync_completed_at,
        error: syncRow.sync_error,
      },
    });
  } catch (err) {
    logger.error('Error fetching Square status', { merchantId, error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /integrations/square/disconnect
 * Removes a merchant's Square connection from Aervo.
 */
router.delete('/disconnect', async (req, res) => {
  const { merchantId } = req.body;
  if (!merchantId) return res.status(400).json({ error: 'merchantId required' });

  try {
    await deleteTokens(merchantId);
    logger.info('Merchant disconnected Square', { merchantId });
    res.json({ success: true, message: 'Square connection removed' });
  } catch (err) {
    logger.error('Error disconnecting Square', { merchantId, error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
