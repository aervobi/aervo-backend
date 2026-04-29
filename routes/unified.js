const express = require("express");
const router = express.Router();
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, message: "Authentication required" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: "Invalid or expired token" });
    req.user = user;
    next();
  });
}

// GET /api/unified/overview
router.get("/overview", authenticateToken, async (req, res) => {
  try {
    const merchantId = req.user.userId;

    // Get user platform
    const userRes = await pool.query(
      "SELECT platform FROM users WHERE id = $1",
      [merchantId]
    );
    if (!userRes.rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const platform = userRes.rows[0].platform;
    let totalRevenue = 0;
    let totalOrders = 0;
    let totalCustomers = 0;
    const sources = [];

    
   // Square data
if (platform === "square" || platform === "both") {
  try {
    console.log("Querying Square for merchantId:", merchantId, typeof merchantId);
    const [ordersRes, customersRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(total_money), 0) as revenue, COUNT(*) as count
         FROM square_orders WHERE merchant_id = $1`,
        [merchantId]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT id) as count FROM square_customers WHERE merchant_id = $1`,
        [merchantId]
      )
    ]);
    console.log("Square orders result:", ordersRes.rows[0]);
    console.log("Square customers result:", customersRes.rows[0]);

    // Shopify data
    if (platform === "shopify" || platform === "both") {
      try {
        const [ordersRes, customersRes] = await Promise.all([
          pool.query(
            `SELECT COALESCE(SUM(total_price::numeric), 0) as revenue, COUNT(*) as count
             FROM shopify_orders WHERE merchant_id = $1`,
            [merchantId]
          ),
          pool.query(
            `SELECT COUNT(DISTINCT id) as count FROM shopify_customers WHERE merchant_id = $1`,
            [merchantId]
          )
        ]);

        const shopifyRevenue = parseFloat(ordersRes.rows[0].revenue);
        const shopifyOrders = parseInt(ordersRes.rows[0].count);
        const shopifyCustomers = parseInt(customersRes.rows[0].count);

        totalRevenue += shopifyRevenue;
        totalOrders += shopifyOrders;
        totalCustomers += shopifyCustomers;

        sources.push({ name: "Shopify", revenue: shopifyRevenue, orders: shopifyOrders, customers: shopifyCustomers });
      } catch (e) {
        console.error("Shopify unified error:", e.message);
      }
    }

    return res.json({
      success: true,
      overview: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalOrders,
        totalCustomers,
        sources
      }
    });

  } catch (err) {
    console.error("Unified overview error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;