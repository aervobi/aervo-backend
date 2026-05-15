const express = require("express");
const router = express.Router();
const pool = require("../db");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

router.post("/chat", async (req, res) => {
  const { message, merchantId, platform } = req.body;

  if (!message || !merchantId) {
    return res.status(400).json({ error: "message and merchantId are required" });
  }

  try {
    // 1. Pull all relevant business data
    const [revenueResult, ordersResult, customersResult, topItemsResult, hourlyResult] =
      await Promise.all([
        pool.query(
          `SELECT COALESCE(SUM(gross_amount), 0) as total_revenue
           FROM square_order_line_items
           WHERE aervo_merchant_id = $1`,
          [merchantId]
        ),
        pool.query(
          `SELECT COUNT(*) as total_orders,
                  AVG(total_money) as avg_order_value,
                  DATE_TRUNC('month', created_at) as month,
                  COUNT(*) as monthly_orders
           FROM square_orders
           WHERE aervo_merchant_id = $1
           GROUP BY DATE_TRUNC('month', created_at)
           ORDER BY month DESC
           LIMIT 12`,
          [merchantId]
        ),
        pool.query(
          `SELECT COUNT(*) as total_customers,
                  COUNT(CASE WHEN visit_count > 1 THEN 1 END) as returning_customers
           FROM square_customers
           WHERE aervo_merchant_id = $1`,
          [merchantId]
        ),
        pool.query(
          `SELECT name, COUNT(*) as orders, SUM(gross_amount) as revenue
           FROM square_order_line_items
           WHERE aervo_merchant_id = $1
           GROUP BY name
           ORDER BY orders DESC
           LIMIT 10`,
          [merchantId]
        ),
        pool.query(
          `SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as orders
           FROM square_orders
           WHERE aervo_merchant_id = $1
           GROUP BY hour
           ORDER BY orders DESC`,
          [merchantId]
        ),
      ]);

    const totalRevenue = parseFloat(revenueResult.rows[0].total_revenue) / 100;
    const totalCustomers = parseInt(customersResult.rows[0].total_customers);
    const returningCustomers = parseInt(customersResult.rows[0].returning_customers);
    const retentionRate = totalCustomers > 0
      ? ((returningCustomers / totalCustomers) * 100).toFixed(1)
      : 0;

    const monthlyOrders = ordersResult.rows.map((r) => ({
      month: r.month?.toISOString().slice(0, 7),
      orders: parseInt(r.monthly_orders),
      avgOrderValue: parseFloat(r.avg_order_value || 0) / 100,
    }));

    const topItems = topItemsResult.rows.map((r) => ({
      name: r.name,
      orders: parseInt(r.orders),
      revenue: parseFloat(r.revenue) / 100,
    }));

    const busiestHours = hourlyResult.rows.slice(0, 3).map((r) => ({
      hour: `${r.hour}:00`,
      orders: parseInt(r.orders),
    }));

    // 2. Build context for the AI
    const businessContext = `
You are Aervo, an AI business co-pilot for small businesses. You have access to real business data for this merchant. Answer questions conversationally and helpfully. Be specific with numbers when relevant. Keep responses concise (2-4 sentences unless a detailed breakdown is asked for).

Here is the merchant's current business data:

OVERVIEW:
- Total Revenue: $${totalRevenue.toLocaleString()}
- Total Orders: ${ordersResult.rows.reduce((a, r) => a + parseInt(r.monthly_orders), 0)}
- Total Customers: ${totalCustomers}
- Returning Customers: ${returningCustomers}
- Retention Rate: ${retentionRate}%

MONTHLY ORDER TRENDS (last 12 months):
${monthlyOrders.map((m) => `- ${m.month}: ${m.orders} orders, avg $${m.avgOrderValue.toFixed(2)}/order`).join("\n")}

TOP SERVICES/ITEMS:
${topItems.map((i, idx) => `${idx + 1}. ${i.name} — ${i.orders} orders, $${i.revenue.toFixed(2)} revenue`).join("\n")}

BUSIEST HOURS:
${busiestHours.map((h) => `- ${h.hour} — ${h.orders} orders`).join("\n")}
    `.trim();

    // 3. Call Anthropic
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: businessContext,
      messages: [{ role: "user", content: message }],
    });

    const reply = response.content[0]?.text || "Sorry, I couldn't generate a response.";
    res.json({ reply });
  } catch (err) {
    console.error("AI chat error:", err);
    res.status(500).json({ error: "AI chat failed", detail: err.message });
  }
});

module.exports = router;