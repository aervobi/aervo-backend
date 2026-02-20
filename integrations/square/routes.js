// integrations/square/routes.js
const express = require('express');
const router = express.Router();

const { handleConnectRequest, handleOAuthCallback } = require('./auth/oauth');
const { handleWebhookEvent } = require('./webhooks/webhookHandler');
const { deleteTokens, getTokensByMerchant } = require('./auth/tokenStore');
const { pool } = require('../../db');

// ── OAuth Flow ────────────────────────────────────────────────────────────────
router.get('/connect', handleConnectRequest);
router.get('/callback', handleOAuthCallback);

// ── Webhooks ──────────────────────────────────────────────────────────────────
router.post('/webhooks', handleWebhookEvent);

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  const { merchantId } = req.query;
  if (!merchantId) return res.status(400).json({ error: 'merchantId required' });

  try {
    const tokens = await getTokensByMerchant(merchantId);
    if (!tokens) return res.json({ connected: false });

    const locResult = await pool.query(
      `SELECT COUNT(*) FROM square_locations WHERE aervo_merchant_id = $1`,
      [merchantId]
    );

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
    console.error('Error fetching Square status', { merchantId, error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Disconnect ────────────────────────────────────────────────────────────────
router.delete('/disconnect', async (req, res) => {
  const { merchantId } = req.body;
  if (!merchantId) return res.status(400).json({ error: 'merchantId required' });

  try {
    await deleteTokens(merchantId);
    console.log('Merchant disconnected Square', { merchantId });
    res.json({ success: true, message: 'Square connection removed' });
  } catch (err) {
    console.error('Error disconnecting Square', { merchantId, error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});
router.get('/locations', async (req, res) => {
  const { merchantId } = req.query;
  if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
  try {
    const result = await pool.query(`SELECT * FROM square_locations WHERE aervo_merchant_id = $1 ORDER BY name`, [merchantId]);
    res.json({ success: true, locations: result.rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/orders', async (req, res) => {
  const { merchantId } = req.query;
  if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
  try {
    const result = await pool.query(`SELECT * FROM square_orders WHERE aervo_merchant_id = $1 ORDER BY created_at DESC LIMIT 200`, [merchantId]);
    res.json({ success: true, orders: result.rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/customers', async (req, res) => {
  const { merchantId } = req.query;
  if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
  try {
    const result = await pool.query(`SELECT * FROM square_customers WHERE aervo_merchant_id = $1 ORDER BY created_at DESC LIMIT 500`, [merchantId]);
    res.json({ success: true, customers: result.rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/appointments', async (req, res) => {
  const { merchantId } = req.query;
  if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
  try {
    const result = await pool.query(`SELECT * FROM square_appointments WHERE aervo_merchant_id = $1 ORDER BY start_at DESC LIMIT 200`, [merchantId]);
    res.json({ success: true, appointments: result.rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
module.exports = router;