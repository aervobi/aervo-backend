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
  const { merchantId, filter, service } = req.query;
  if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
  try {
    let dateFilter = '';
    if (filter === 'today') dateFilter = `AND o.created_at >= CURRENT_DATE`;
    else if (filter === '7days') dateFilter = `AND o.created_at >= NOW() - INTERVAL '7 days'`;
    else if (filter === '30days') dateFilter = `AND o.created_at >= NOW() - INTERVAL '30 days'`;

    let serviceFilter = '';
    if (service) serviceFilter = `AND EXISTS (SELECT 1 FROM square_order_line_items li2 WHERE li2.square_order_id = o.square_order_id AND li2.name ILIKE $2)`;

    const params = service ? [merchantId, `%${service}%`] : [merchantId];

    const result = await pool.query(`
      SELECT 
        o.*,
        COALESCE(SUM(li.gross_amount::numeric), 0) as computed_total,
        TRIM(COALESCE(c.given_name, '') || ' ' || COALESCE(c.family_name, '')) as customer_name,
        STRING_AGG(DISTINCT li.name, ', ') FILTER (WHERE li.name != 'Tip') as services,
        JSON_AGG(JSON_BUILD_OBJECT(
          'name', li.name,
          'quantity', li.quantity,
          'amount', li.gross_amount
        )) FILTER (WHERE li.name IS NOT NULL) as line_items
      FROM square_orders o
      LEFT JOIN square_order_line_items li ON li.square_order_id = o.square_order_id
      LEFT JOIN square_customers c ON c.square_customer_id = o.square_customer_id 
        AND c.aervo_merchant_id = o.aervo_merchant_id
      WHERE o.aervo_merchant_id = $1 ${dateFilter} ${serviceFilter}
      GROUP BY o.id, c.given_name, c.family_name
      ORDER BY o.created_at DESC LIMIT 1000
    `, params);

    const orders = result.rows.map(o => ({
      ...o,
      total_amount: parseFloat(o.computed_total) || 0
    }));
    res.json({ success: true, orders });
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
router.get('/top-items', async (req, res) => {
  const { merchantId } = req.query;

  if (!merchantId) {
    return res.status(400).json({ error: "merchantId is required" });
  }

  try {
    const result = await pool.query(
      `SELECT 
        name,
        SUM(quantity) as total_quantity,
        SUM(gross_amount) as total_revenue,
        COUNT(DISTINCT square_order_id) as total_orders
       FROM square_order_line_items
       WHERE aervo_merchant_id = $1
         AND name IS NOT NULL
         AND name != ''
       GROUP BY name
       ORDER BY total_orders DESC
       LIMIT 10`,
      [merchantId]
    );

    const items = result.rows.map(r => ({
      name: r.name,
      quantity: parseFloat(r.total_quantity),
      revenue: parseFloat(r.total_revenue) / 100,
      orders: parseInt(r.total_orders)
    }));

    res.json({ success: true, items });
  } catch (err) {
    console.error("Top items error:", err);
    res.status(500).json({ error: "Failed to fetch top items" });
  }
});

module.exports = router;

router.get('/customers/enriched', async (req, res) => {
  const { merchantId, segment, search } = req.query;
  if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
  try {
    let searchFilter = '';
    if (search) searchFilter = `AND (c.given_name ILIKE $2 OR c.family_name ILIKE $2 OR c.email_address ILIKE $2)`;
    const params = search ? [merchantId, `%${search}%`] : [merchantId];

    const result = await pool.query(`
      SELECT 
        c.*,
        COUNT(DISTINCT o.id) as visit_count,
        COALESCE(SUM(li.gross_amount::numeric), 0) as total_spend,
        MAX(o.created_at) as last_visit,
        CASE 
          WHEN COUNT(DISTINCT o.id) = 0 THEN 'no_visits'
          WHEN MAX(o.created_at) < NOW() - INTERVAL '60 days' THEN 'at_risk'
          WHEN COUNT(DISTINCT o.id) >= 3 THEN 'loyal'
          WHEN c.created_at >= NOW() - INTERVAL '30 days' THEN 'new'
          ELSE 'regular'
        END as computed_segment,
        COALESCE(SUM(li.gross_amount::numeric), 0) / NULLIF(COUNT(DISTINCT o.id), 0) as avg_spend
      FROM square_customers c
      LEFT JOIN square_orders o ON o.square_customer_id = c.square_customer_id 
        AND o.aervo_merchant_id = c.aervo_merchant_id
      LEFT JOIN square_order_line_items li ON li.square_order_id = o.square_order_id
      WHERE c.aervo_merchant_id = $1 ${searchFilter}
      GROUP BY c.id
      ORDER BY total_spend DESC
    `, params);

    // Deduplicate by email keeping highest spend
    const seen = new Map();
    result.rows.forEach(c => {
      const key = c.email_address || c.square_customer_id;
      if (!seen.has(key) || parseFloat(c.total_spend) > parseFloat(seen.get(key).total_spend)) {
        seen.set(key, c);
      }
    });
    const customers = Array.from(seen.values());

    // Filter by segment if requested
    const filtered = segment ? customers.filter(c => c.computed_segment === segment) : customers;

    res.json({ success: true, customers: filtered });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});