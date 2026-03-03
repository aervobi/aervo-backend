const express = require("express");
const router = express.Router();
const Anthropic = require("@anthropic-ai/sdk");

module.exports = (pool, authenticateToken) => {

  // ════════════════════════════════════════════════════════
  //  HEALTH SCORE HISTORY
  //  GET /api/health-scores/history?period=3m|6m|1y
  // ════════════════════════════════════════════════════════
  router.get("/api/health-scores/history", authenticateToken, async (req, res) => {
    try {
      const { period = "3m" } = req.query;
      const months = { "3m": 3, "6m": 6, "1y": 12 }[period] || 3;

      const rows = await pool.query(
        `SELECT
           TO_CHAR(DATE_TRUNC('month', calculated_at), 'Mon') AS label,
           DATE_TRUNC('month', calculated_at) AS month_start,
           ROUND(AVG(score)) AS score
         FROM health_scores
         WHERE user_id = $1
           AND calculated_at >= NOW() - ($2 || ' months')::INTERVAL
         GROUP BY DATE_TRUNC('month', calculated_at)
         ORDER BY DATE_TRUNC('month', calculated_at) ASC`,
        [req.user.userId, months]
      );

      return res.json({
        success: true,
        labels: rows.rows.map(r => r.label),
        scores: rows.rows.map(r => parseInt(r.score)),
      });
    } catch (err) {
      console.error("History error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ════════════════════════════════════════════════════════
  //  GOALS — CRUD
  // ════════════════════════════════════════════════════════

  // GET /api/goals — list goals with auto-updated current values
  router.get("/api/goals", authenticateToken, async (req, res) => {
    try {
      const goalsResult = await pool.query(
        `SELECT * FROM goals WHERE user_id = $1 ORDER BY created_at ASC`,
        [req.user.userId]
      );
      const goals = goalsResult.rows;

      // Auto-update current values from connected store data
      const userResult = await pool.query(
        `SELECT u.id, cs.shop_origin, cs.integration_name, cs.access_token
         FROM users u
         LEFT JOIN connected_stores cs ON cs.user_id = u.id AND cs.is_active = true
         WHERE u.id = $1`,
        [req.user.userId]
      );

      if (userResult.rows.length > 0) {
        const store = userResult.rows[0];
        let storeMetrics = null;

        try {
          if (store.shop_origin && store.integration_name !== "square") {
            storeMetrics = await fetchShopifyMetrics(store.shop_origin, store.access_token);
          } else if (store.integration_name === "square") {
            storeMetrics = await fetchSquareMetrics(store.access_token);
          }
        } catch (e) {
          console.error("Metrics fetch error:", e);
        }

        if (storeMetrics) {
          for (const goal of goals) {
            let newCurrent = goal.current;
            if (goal.type === "revenue")   newCurrent = storeMetrics.revenue;
            if (goal.type === "orders")    newCurrent = storeMetrics.orders;
            if (goal.type === "aov")       newCurrent = storeMetrics.aov;
            if (goal.type === "customers") newCurrent = storeMetrics.newCustomers;

            if (newCurrent !== goal.current) {
              await pool.query(
                `UPDATE goals SET current = $1, updated_at = NOW() WHERE id = $2`,
                [newCurrent, goal.id]
              );
              goal.current = newCurrent;
            }
          }
        }
      }

      return res.json({ success: true, goals });
    } catch (err) {
      console.error("Goals GET error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // POST /api/goals — create a goal
  router.post("/api/goals", authenticateToken, async (req, res) => {
    try {
      const { type, target, current = 0 } = req.body;
      if (!type || !target) {
        return res.status(400).json({ success: false, message: "type and target required" });
      }
      const result = await pool.query(
        `INSERT INTO goals (user_id, type, target, current)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.user.userId, type, target, current]
      );
      return res.json({ success: true, goal: result.rows[0] });
    } catch (err) {
      console.error("Goals POST error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // PUT /api/goals/:id — update a goal
  router.put("/api/goals/:id", authenticateToken, async (req, res) => {
    try {
      const { target, current } = req.body;
      const result = await pool.query(
        `UPDATE goals SET target = COALESCE($1, target), current = COALESCE($2, current),
         updated_at = NOW()
         WHERE id = $3 AND user_id = $4 RETURNING *`,
        [target, current, req.params.id, req.user.userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Goal not found" });
      }
      return res.json({ success: true, goal: result.rows[0] });
    } catch (err) {
      console.error("Goals PUT error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // DELETE /api/goals/:id
  router.delete("/api/goals/:id", authenticateToken, async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM goals WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.userId]
      );
      return res.json({ success: true });
    } catch (err) {
      console.error("Goals DELETE error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ════════════════════════════════════════════════════════
  //  ACTION PLAN
  // ════════════════════════════════════════════════════════

  // GET /api/action-plan — get this week's plan (or auto-generate if none)
  router.get("/api/action-plan", authenticateToken, async (req, res) => {
    try {
      const now = new Date();
      const jan1 = new Date(now.getFullYear(), 0, 1);
      const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      const year = now.getFullYear();

      const existing = await pool.query(
        `SELECT * FROM action_plan_items
         WHERE user_id = $1 AND week_number = $2 AND year = $3
         ORDER BY id ASC`,
        [req.user.userId, week, year]
      );

      if (existing.rows.length > 0) {
        return res.json({ success: true, actions: existing.rows, week, year });
      }

      // No plan this week — auto-generate one
      const generated = await generateActionPlan(pool, req.user.userId, week, year);
      return res.json({ success: true, actions: generated, week, year });
    } catch (err) {
      console.error("Action plan GET error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // POST /api/action-plan/regenerate — force a new plan
  router.post("/api/action-plan/regenerate", authenticateToken, async (req, res) => {
    try {
      const now = new Date();
      const jan1 = new Date(now.getFullYear(), 0, 1);
      const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      const year = now.getFullYear();

      // Delete old plan for this week
      await pool.query(
        `DELETE FROM action_plan_items WHERE user_id = $1 AND week_number = $2 AND year = $3`,
        [req.user.userId, week, year]
      );

      const generated = await generateActionPlan(pool, req.user.userId, week, year);
      return res.json({ success: true, actions: generated, week, year });
    } catch (err) {
      console.error("Action plan regenerate error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // PATCH /api/action-plan/:id — toggle done
  router.patch("/api/action-plan/:id", authenticateToken, async (req, res) => {
    try {
      const { done } = req.body;
      const result = await pool.query(
        `UPDATE action_plan_items SET done = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
        [done, req.params.id, req.user.userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Item not found" });
      }
      return res.json({ success: true, item: result.rows[0] });
    } catch (err) {
      console.error("Action plan PATCH error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ════════════════════════════════════════════════════════
  //  HELPERS
  // ════════════════════════════════════════════════════════

  async function generateActionPlan(pool, userId, week, year) {
    // Get latest health score
    const scoreResult = await pool.query(
      `SELECT * FROM health_scores WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1`,
      [userId]
    );
    const score = scoreResult.rows[0];

    // Get goals
    const goalsResult = await pool.query(
      `SELECT * FROM goals WHERE user_id = $1`,
      [userId]
    );
    const goals = goalsResult.rows;

    const scoreCtx = score
      ? `Health score: ${score.score}/100. Revenue score: ${score.revenue_score}/25, Orders: ${score.orders_score}/20, Refunds: ${score.refund_score}/20, Inventory: ${score.inventory_score}/20, Retention: ${score.retention_score}/15.`
      : "Health score: not yet calculated.";

    const goalsCtx = goals.length > 0
      ? goals.map(g => `${g.type}: ${Math.round(g.current / g.target * 100)}% to goal`).join("; ")
      : "No goals set yet.";

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const aiResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are a business intelligence AI for an ecommerce merchant dashboard called Aervo.

${scoreCtx}
Goals progress: ${goalsCtx}

Generate exactly 6 actionable weekly priorities as a JSON array. No markdown, no preamble, just the JSON array:
[{ "priority": "high"|"med"|"low", "text": "specific 1-2 sentence task", "impact": "brief expected outcome" }]`
      }]
    });

    let items = [];
    try {
      const raw = aiResponse.content[0].text.replace(/```json|```/g, "").trim();
      items = JSON.parse(raw);
    } catch (e) {
      // Fallback items if AI parsing fails
      items = [
        { priority: "high", text: "Review your refund rate and identify the top 3 products with the most returns.", impact: "Reduce refund losses" },
        { priority: "high", text: "Set up a post-purchase email sequence to bring customers back.", impact: "Improve retention rate" },
        { priority: "med",  text: "Check and restock any low-inventory SKUs before the weekend.", impact: "Prevent lost sales" },
        { priority: "med",  text: "Review and optimize product descriptions for your top 3 sellers.", impact: "Reduce return rate by 5-10%" },
        { priority: "low",  text: "Set up an abandoned cart email flow to recover lost traffic.", impact: "+0.5-1% conversion lift" },
        { priority: "low",  text: "Review pricing against competitors for your best-selling items.", impact: "Potential AOV increase" },
      ];
    }

    // Save to DB
    const saved = [];
    for (const item of items) {
      const result = await pool.query(
        `INSERT INTO action_plan_items (user_id, week_number, year, priority, text, impact, done)
         VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING *`,
        [userId, week, year, item.priority, item.text, item.impact]
      );
      saved.push(result.rows[0]);
    }
    return saved;
  }

  async function fetchShopifyMetrics(shopOrigin, accessToken) {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const headers = { "X-Shopify-Access-Token": accessToken };

    const [ordersRes, customersRes] = await Promise.all([
      fetch(`https://${shopOrigin}/admin/api/2024-01/orders.json?status=any&created_at_min=${thirtyDaysAgo}&limit=250`, { headers }),
      fetch(`https://${shopOrigin}/admin/api/2024-01/customers.json?created_at_min=${thirtyDaysAgo}&limit=250`, { headers }),
    ]);

    const [ordersData, customersData] = await Promise.all([ordersRes.json(), customersRes.json()]);
    const orders = ordersData.orders || [];
    const revenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
    const aov = orders.length > 0 ? revenue / orders.length : 0;

    return {
      revenue: Math.round(revenue),
      orders: orders.length,
      aov: Math.round(aov * 100) / 100,
      newCustomers: (customersData.customers || []).length,
    };
  }

  async function fetchSquareMetrics(accessToken) {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const headers = { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" };

    const locRes = await fetch("https://connect.squareup.com/v2/locations", { headers });
    const locData = await locRes.json();
    const locationIds = (locData.locations || []).map(l => l.id);
    if (locationIds.length === 0) return null;

    const ordersRes = await fetch("https://connect.squareup.com/v2/orders/search", {
      method: "POST",
      headers,
      body: JSON.stringify({
        location_ids: locationIds,
        query: { filter: { date_time_filter: { created_at: { start_at: thirtyDaysAgo } } } },
        limit: 500,
      }),
    });

    const ordersData = await ordersRes.json();
    const orders = ordersData.orders || [];
    const revenue = orders.reduce((s, o) => s + (o.total_money?.amount || 0), 0) / 100;
    const aov = orders.length > 0 ? revenue / orders.length : 0;

    const cusRes = await fetch("https://connect.squareup.com/v2/customers?limit=200", { headers });
    const cusData = await cusRes.json();

    return {
      revenue: Math.round(revenue),
      orders: orders.length,
      aov: Math.round(aov * 100) / 100,
      newCustomers: (cusData.customers || []).length,
    };
  }

  return router;
};