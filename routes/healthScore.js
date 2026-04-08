const express = require("express");
const router = express.Router();
const Anthropic = require("@anthropic-ai/sdk");

module.exports = (pool, authenticateToken) => {

  // ── GET /api/health-score ──────────────────────────────────────
  router.get("/api/health-score", authenticateToken, async (req, res) => {
    try {
      // Return latest cached score if calculated within last 24 hours
      const cached = await pool.query(
        `SELECT * FROM health_scores WHERE user_id = $1 
         AND calculated_at > NOW() - INTERVAL '24 hours'
         ORDER BY calculated_at DESC LIMIT 1`,
        [req.user.userId]
      );

      if (cached.rows.length > 0) {
        return res.json({ success: true, score: cached.rows[0], cached: true });
      }

      return res.json({ success: true, score: null, cached: false });
    } catch (err) {
      console.error("Health score error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── POST /api/health-score/calculate ─────────────────────────
router.post("/api/health-score/calculate", authenticateToken, async (req, res) => {
  try {
    const { shopOrigin, merchantId } = req.body;

    let currentOrders = [], prevOrders = [], products = [];
    let platform = null;

    if (shopOrigin) {
      // ── SHOPIFY ──────────────────────────────────────────────
      platform = "shopify";
      const storeResult = await pool.query(
        `SELECT access_token FROM connected_stores 
         WHERE user_id = $1 AND store_origin = $2 AND is_active = true`,
        [req.user.userId, shopOrigin]
      );
      if (storeResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Store not found" });
      }
      const accessToken = storeResult.rows[0].access_token;
      const shopDomain = `https://${shopOrigin}`;
      const now = new Date();
      const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
      const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();
      const headers = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };

      const [currentRes, prevRes, invRes] = await Promise.all([
        fetch(`${shopDomain}/admin/api/2024-01/orders.json?status=any&created_at_min=${thirtyDaysAgo}&limit=250`, { headers }),
        fetch(`${shopDomain}/admin/api/2024-01/orders.json?status=any&created_at_min=${sixtyDaysAgo}&created_at_max=${thirtyDaysAgo}&limit=250`, { headers }),
        fetch(`${shopDomain}/admin/api/2024-01/products.json?limit=250`, { headers })
      ]);

      const [currentData, prevData, invData] = await Promise.all([currentRes.json(), prevRes.json(), invRes.json()]);
      currentOrders = currentData.orders || [];
      prevOrders = prevData.orders || [];
      products = invData.products || [];

    } else if (merchantId) {
      platform = "square";
      const now = new Date();
      const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
      const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();

      const [currentRes, prevRes] = await Promise.all([
        pool.query(`
          SELECT o.square_customer_id as email,
            COALESCE(SUM(li.gross_amount::numeric), 0) as total_price
          FROM square_orders o
          LEFT JOIN square_order_line_items li ON li.square_order_id = o.square_order_id
          WHERE o.aervo_merchant_id = $1 AND o.created_at >= $2
          GROUP BY o.id, o.square_customer_id
        `, [merchantId, thirtyDaysAgo]),
        pool.query(`
          SELECT o.square_customer_id as email,
            COALESCE(SUM(li.gross_amount::numeric), 0) as total_price
          FROM square_orders o
          LEFT JOIN square_order_line_items li ON li.square_order_id = o.square_order_id
          WHERE o.aervo_merchant_id = $1 AND o.created_at >= $2 AND o.created_at < $3
          GROUP BY o.id, o.square_customer_id
        `, [merchantId, sixtyDaysAgo, thirtyDaysAgo])
      ]);

      currentOrders = currentRes.rows.map(o => ({
        total_price: (parseFloat(o.total_price) / 100).toFixed(2),
        financial_status: 'paid',
        email: o.email
      }));
      prevOrders = prevRes.rows.map(o => ({
        total_price: (parseFloat(o.total_price) / 100).toFixed(2),
        financial_status: 'paid',
        email: o.email
      }));

    } else {
      return res.status(400).json({ success: false, message: "shopOrigin or merchantId required" });
    }

    // ── CALCULATE METRICS (same for both platforms) ────────────
    const currentRevenue = currentOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const prevRevenue = prevOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const revenueChange = prevRevenue > 0 ? ((currentRevenue - prevRevenue) / prevRevenue) * 100 : 0;

    const currentOrderCount = currentOrders.length;
    const prevOrderCount = prevOrders.length;
    const orderChange = prevOrderCount > 0 ? ((currentOrderCount - prevOrderCount) / prevOrderCount) * 100 : 0;

    const refundedOrders = currentOrders.filter(o => o.financial_status === "refunded" || o.financial_status === "partially_refunded");
    const refundRate = currentOrders.length > 0 ? (refundedOrders.length / currentOrders.length) * 100 : 0;

    const allVariants = products.flatMap(p => p.variants || []);
    const outOfStock = allVariants.filter(v => v.inventory_quantity <= 0).length;
    const totalVariants = allVariants.length;
    const outOfStockRate = totalVariants > 0 ? (outOfStock / totalVariants) * 100 : 0;

    const currentCustomers = new Set(currentOrders.map(o => o.email).filter(Boolean));
    const prevCustomers = new Set(prevOrders.map(o => o.email).filter(Boolean));
    const returningCustomers = [...currentCustomers].filter(e => prevCustomers.has(e)).length;
    const retentionRate = currentCustomers.size > 0 ? (returningCustomers / currentCustomers.size) * 100 : 0;

    // ── SCORING ────────────────────────────────────────────────
    let revenueScore = revenueChange >= 20 ? 25 : revenueChange >= 10 ? 22 : revenueChange >= 5 ? 19 : revenueChange >= 0 ? 15 : revenueChange >= -10 ? 10 : revenueChange >= -20 ? 5 : 0;
    let ordersScore = orderChange >= 20 ? 20 : orderChange >= 10 ? 17 : orderChange >= 5 ? 14 : orderChange >= 0 ? 11 : orderChange >= -10 ? 7 : orderChange >= -20 ? 3 : 0;
    let refundScore = refundRate <= 1 ? 20 : refundRate <= 2 ? 17 : refundRate <= 3 ? 14 : refundRate <= 5 ? 10 : refundRate <= 8 ? 5 : 0;
    let inventoryScore = platform === "square" ? 16 : outOfStockRate <= 2 ? 20 : outOfStockRate <= 5 ? 16 : outOfStockRate <= 10 ? 12 : outOfStockRate <= 20 ? 7 : outOfStockRate <= 35 ? 3 : 0;
    let retentionScore = retentionRate >= 40 ? 15 : retentionRate >= 30 ? 12 : retentionRate >= 20 ? 9 : retentionRate >= 10 ? 6 : retentionRate >= 5 ? 3 : 0;

    const totalScore = revenueScore + ordersScore + refundScore + inventoryScore + retentionScore;

    // ── AI SUMMARY ────────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const aiResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `A ${platform} business has a health score of ${totalScore}/100. Metrics:
- Revenue change: ${revenueChange.toFixed(1)}% (score: ${revenueScore}/25)
- Order volume change: ${orderChange.toFixed(1)}% (score: ${ordersScore}/20)
- Refund rate: ${refundRate.toFixed(1)}% (score: ${refundScore}/20)
- Inventory score: ${inventoryScore}/20
- Customer retention: ${retentionRate.toFixed(1)}% (score: ${retentionScore}/15)

Respond ONLY with JSON (no markdown):
{
  "summary": "2 sentence summary of overall business health with specific numbers",
  "positives": ["one thing going well", "another thing going well"],
  "improvements": ["top priority to improve", "second priority to improve"]
}`
      }]
    });

    let aiData = { summary: "", positives: [], improvements: [] };
    try {
      aiData = JSON.parse(aiResponse.content[0]?.text.replace(/```json|```/g, "").trim() || "{}");
    } catch(e) {
      aiData.summary = `Your business health score is ${totalScore}/100.`;
    }

    const saved = await pool.query(
      `INSERT INTO health_scores 
       (user_id, score, revenue_score, orders_score, refund_score, inventory_score, retention_score, summary, improvements)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.userId, totalScore, revenueScore, ordersScore, refundScore, inventoryScore, retentionScore, aiData.summary, JSON.stringify({ positives: aiData.positives, improvements: aiData.improvements })]
    );

    return res.json({ success: true, score: saved.rows[0], details: { revenueChange: revenueChange.toFixed(1), orderChange: orderChange.toFixed(1), refundRate: refundRate.toFixed(1), outOfStockRate: outOfStockRate.toFixed(1), retentionRate: retentionRate.toFixed(1) }, ai: aiData });

  } catch (err) {
    console.error("Health score calculate error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

  return router;
};