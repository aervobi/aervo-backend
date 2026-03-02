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
      const { shopOrigin } = req.body;

      if (!shopOrigin) {
        return res.status(400).json({ success: false, message: "Shop origin required" });
      }

      // Get Shopify access token
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

      // Fetch 30 day and 60 day data for comparison
      const now = new Date();
      const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
      const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();

      const headers = {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json"
      };

      // Fetch current 30 days orders
      const [currentOrdersRes, prevOrdersRes, inventoryRes] = await Promise.all([
        fetch(`${shopDomain}/admin/api/2024-01/orders.json?status=any&created_at_min=${thirtyDaysAgo}&limit=250`, { headers }),
        fetch(`${shopDomain}/admin/api/2024-01/orders.json?status=any&created_at_min=${sixtyDaysAgo}&created_at_max=${thirtyDaysAgo}&limit=250`, { headers }),
        fetch(`${shopDomain}/admin/api/2024-01/products.json?limit=250`, { headers })
      ]);

      const [currentOrdersData, prevOrdersData, inventoryData] = await Promise.all([
        currentOrdersRes.json(),
        prevOrdersRes.json(),
        inventoryRes.json()
      ]);

      const currentOrders = currentOrdersData.orders || [];
      const prevOrders = prevOrdersData.orders || [];
      const products = inventoryData.products || [];

      // ── CALCULATE METRICS ──────────────────────────────────────

      // Revenue
      const currentRevenue = currentOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
      const prevRevenue = prevOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
      const revenueChange = prevRevenue > 0 ? ((currentRevenue - prevRevenue) / prevRevenue) * 100 : 0;

      // Orders
      const currentOrderCount = currentOrders.length;
      const prevOrderCount = prevOrders.length;
      const orderChange = prevOrderCount > 0 ? ((currentOrderCount - prevOrderCount) / prevOrderCount) * 100 : 0;

      // Refunds
      const refundedOrders = currentOrders.filter(o => o.financial_status === "refunded" || o.financial_status === "partially_refunded");
      const refundRate = currentOrders.length > 0 ? (refundedOrders.length / currentOrders.length) * 100 : 0;

      // Inventory
      const allVariants = products.flatMap(p => p.variants || []);
      const outOfStock = allVariants.filter(v => v.inventory_quantity <= 0).length;
      const totalVariants = allVariants.length;
      const outOfStockRate = totalVariants > 0 ? (outOfStock / totalVariants) * 100 : 0;

      // Customer retention
      const currentCustomers = new Set(currentOrders.map(o => o.email).filter(Boolean));
      const prevCustomers = new Set(prevOrders.map(o => o.email).filter(Boolean));
      const returningCustomers = [...currentCustomers].filter(e => prevCustomers.has(e)).length;
      const retentionRate = currentCustomers.size > 0 ? (returningCustomers / currentCustomers.size) * 100 : 0;

      // ── SCORE CALCULATION ──────────────────────────────────────

      // Revenue score (25pts)
      let revenueScore = 0;
      if (revenueChange >= 20) revenueScore = 25;
      else if (revenueChange >= 10) revenueScore = 22;
      else if (revenueChange >= 5) revenueScore = 19;
      else if (revenueChange >= 0) revenueScore = 15;
      else if (revenueChange >= -10) revenueScore = 10;
      else if (revenueChange >= -20) revenueScore = 5;
      else revenueScore = 0;

      // Orders score (20pts)
      let ordersScore = 0;
      if (orderChange >= 20) ordersScore = 20;
      else if (orderChange >= 10) ordersScore = 17;
      else if (orderChange >= 5) ordersScore = 14;
      else if (orderChange >= 0) ordersScore = 11;
      else if (orderChange >= -10) ordersScore = 7;
      else if (orderChange >= -20) ordersScore = 3;
      else ordersScore = 0;

      // Refund score (20pts) — lower is better
      let refundScore = 0;
      if (refundRate <= 1) refundScore = 20;
      else if (refundRate <= 2) refundScore = 17;
      else if (refundRate <= 3) refundScore = 14;
      else if (refundRate <= 5) refundScore = 10;
      else if (refundRate <= 8) refundScore = 5;
      else refundScore = 0;

      // Inventory score (20pts) — lower out of stock is better
      let inventoryScore = 0;
      if (outOfStockRate <= 2) inventoryScore = 20;
      else if (outOfStockRate <= 5) inventoryScore = 16;
      else if (outOfStockRate <= 10) inventoryScore = 12;
      else if (outOfStockRate <= 20) inventoryScore = 7;
      else if (outOfStockRate <= 35) inventoryScore = 3;
      else inventoryScore = 0;

      // Retention score (15pts)
      let retentionScore = 0;
      if (retentionRate >= 40) retentionScore = 15;
      else if (retentionRate >= 30) retentionScore = 12;
      else if (retentionRate >= 20) retentionScore = 9;
      else if (retentionRate >= 10) retentionScore = 6;
      else if (retentionRate >= 5) retentionScore = 3;
      else retentionScore = 0;

      const totalScore = revenueScore + ordersScore + refundScore + inventoryScore + retentionScore;

      // ── AI SUMMARY ────────────────────────────────────────────
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const aiResponse = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{
          role: "user",
          content: `A business has a health score of ${totalScore}/100. Here are their metrics:
- Revenue change (30d vs prev 30d): ${revenueChange.toFixed(1)}% (score: ${revenueScore}/25)
- Order volume change: ${orderChange.toFixed(1)}% (score: ${ordersScore}/20)
- Refund rate: ${refundRate.toFixed(1)}% (score: ${refundScore}/20)
- Out of stock rate: ${outOfStockRate.toFixed(1)}% (score: ${inventoryScore}/20)
- Customer retention rate: ${retentionRate.toFixed(1)}% (score: ${retentionScore}/15)

Respond with ONLY a JSON object (no markdown):
{
  "summary": "2 sentence summary of overall business health, be specific with numbers",
  "positives": ["one thing going well", "another thing going well"],
  "improvements": ["top priority to improve", "second priority to improve"]
}`
        }]
      });

      let aiData = { summary: "", positives: [], improvements: [] };
      try {
        const raw = aiResponse.content[0]?.text || "{}";
        aiData = JSON.parse(raw.replace(/```json|```/g, "").trim());
      } catch(e) {
        aiData.summary = `Your business health score is ${totalScore}/100.`;
        aiData.improvements = ["Generate more reports for detailed insights"];
      }

      // Save to DB
      const saved = await pool.query(
        `INSERT INTO health_scores 
         (user_id, score, revenue_score, orders_score, refund_score, inventory_score, retention_score, summary, improvements)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          req.user.userId,
          totalScore,
          revenueScore,
          ordersScore,
          refundScore,
          inventoryScore,
          retentionScore,
          aiData.summary,
          JSON.stringify({ positives: aiData.positives, improvements: aiData.improvements })
        ]
      );

      return res.json({
        success: true,
        score: saved.rows[0],
        details: {
          revenueChange: revenueChange.toFixed(1),
          orderChange: orderChange.toFixed(1),
          refundRate: refundRate.toFixed(1),
          outOfStockRate: outOfStockRate.toFixed(1),
          retentionRate: retentionRate.toFixed(1)
        },
        ai: aiData
      });

    } catch (err) {
      console.error("Health score calculate error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
};