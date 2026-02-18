require("dotenv").config();
require("./utils/shopify");
const { createVerifyToken } = require("./utils/emailVerify");
console.log("APP_URL =", process.env.APP_URL);

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");

const {
  initSendgrid,
  sendWelcomeEmail,
  sendVerifyEmail,
  sendPasswordResetEmail,
} = require("./utils/email");

// ============= EXPRESS + DB SETUP =============
const app = express();
app.set("trust proxy", 1);
app.use(cors());

app.use((req, res, next) => {
  if (req.originalUrl === "/shopify/webhooks") return next();
  return express.json()(req, res, next);
});

app.use(cookieParser());
initSendgrid();

// ============= RATE LIMITING =============
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfterSeconds = Math.ceil((15 * 60 * 1000) / 1000);
    res.set("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      success: false,
      code: "RATE_LIMITED",
      message: "Aervo Shield is on. Too many attempts from this device.",
      hint: "Wait a minute and try again. If you're stuck, use 'Forgot password.'",
      retryAfterSeconds,
    });
  },
});

const isHostedDb =
  process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isHostedDb ? { rejectUnauthorized: false } : false,
});

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_key_change_me";

// ============= JWT MIDDLEWARE =============
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: "Invalid or expired token" });
    }
    req.user = user;
    next();
  });
}

// ============= DATABASE SETUP =============
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id SERIAL PRIMARY KEY,
        shop_origin TEXT UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        scope TEXT,
        installed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS shopify_oauth_states (
        id SERIAL PRIMARY KEY,
        shop_origin TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ⭐ Link each shop to the user who connected it
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)`);
    await pool.query(`ALTER TABLE shopify_oauth_states ADD COLUMN IF NOT EXISTS user_id INTEGER`);

    console.log("✅ Shopify tables ensured");
  } catch (err) {
    console.error("❌ Failed to ensure Shopify tables:", err);
  }
})();

const shopifyRouter = require("./routes/shopify")(pool);
app.use("/auth/shopify", shopifyRouter);

// ============= HEALTH CHECK =============
app.get("/", (req, res) => {
  res.send("Aervo backend is running!");
});

// ============= HELPER: GET SHOP TOKEN (user-scoped) =============
// Verifies the shop belongs to the requesting user before returning token
async function getShopToken(shop, userId) {
  const result = await pool.query(
    `SELECT access_token FROM shops 
     WHERE shop_origin = $1 AND (user_id = $2 OR user_id IS NULL)`,
    [shop, userId]
  );

  if (result.rows.length === 0) {
    throw new Error("Shop not found or access denied");
  }

  return result.rows[0].access_token;
}

// ============= HELPER FUNCTIONS =============
function getDateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function isToday(date) {
  return date.toDateString() === new Date().toDateString();
}

function isYesterday(date) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return date.toDateString() === y.toDateString();
}

function isLastMonth(date) {
  const last = new Date();
  last.setMonth(last.getMonth() - 1);
  return date >= last && date < new Date();
}

// ============================================================
// MULTI-INTEGRATION BACKEND ENDPOINTS
// Add to your index.js (before const PORT line)
// ============================================================

// ============= GET ALL AVAILABLE INTEGRATIONS =============
app.get("/api/integrations", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, display_name, description, icon_url, is_active 
       FROM integrations 
       WHERE is_active = true 
       ORDER BY name`
    );

    return res.json({
      success: true,
      integrations: result.rows
    });
  } catch (err) {
    console.error("Get integrations error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch integrations" });
  }
});

// ============= GET USER'S CONNECTED STORES =============
app.get("/api/integrations/connected", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, integration_name, store_id, store_name, store_origin, 
              is_active, connected_at, last_sync_at
       FROM connected_stores 
       WHERE user_id = $1 
       ORDER BY is_active DESC, connected_at DESC`,
      [req.user.userId]
    );

    return res.json({
      success: true,
      stores: result.rows
    });
  } catch (err) {
    console.error("Get connected stores error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch connected stores" });
  }
});

// ============= SET ACTIVE STORE =============
app.post("/api/integrations/set-active", authenticateToken, async (req, res) => {
  try {
    const { storeId } = req.body;

    if (!storeId) {
      return res.status(400).json({ success: false, message: "Store ID required" });
    }

    // Verify store belongs to user
    const checkStore = await pool.query(
      `SELECT id FROM connected_stores WHERE id = $1 AND user_id = $2`,
      [storeId, req.user.userId]
    );

    if (checkStore.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Store not found" });
    }

    // Set all stores to inactive
    await pool.query(
      `UPDATE connected_stores SET is_active = false WHERE user_id = $1`,
      [req.user.userId]
    );

    // Set selected store to active
    await pool.query(
      `UPDATE connected_stores SET is_active = true WHERE id = $1`,
      [storeId]
    );

    // Update user preferences
    await pool.query(
      `INSERT INTO user_preferences (user_id, active_store_id, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET active_store_id = $2, updated_at = NOW()`,
      [req.user.userId, storeId]
    );

    return res.json({ success: true, message: "Active store updated" });
  } catch (err) {
    console.error("Set active store error:", err);
    return res.status(500).json({ success: false, message: "Failed to set active store" });
  }
});

// ============= DISCONNECT STORE =============
app.delete("/api/integrations/disconnect/:storeId", authenticateToken, async (req, res) => {
  try {
    const { storeId } = req.params;

    // Verify store belongs to user
    const checkStore = await pool.query(
      `SELECT id FROM connected_stores WHERE id = $1 AND user_id = $2`,
      [storeId, req.user.userId]
    );

    if (checkStore.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Store not found" });
    }

    // Delete the store
    await pool.query(
      `DELETE FROM connected_stores WHERE id = $1`,
      [storeId]
    );

    // If this was the active store, set another one as active
    const remainingStores = await pool.query(
      `SELECT id FROM connected_stores WHERE user_id = $1 LIMIT 1`,
      [req.user.userId]
    );

    if (remainingStores.rows.length > 0) {
      await pool.query(
        `UPDATE connected_stores SET is_active = true WHERE id = $1`,
        [remainingStores.rows[0].id]
      );
    }

    return res.json({ success: true, message: "Store disconnected" });
  } catch (err) {
    console.error("Disconnect store error:", err);
    return res.status(500).json({ success: false, message: "Failed to disconnect store" });
  }
});

// ============= UPDATE /api/user/me TO RETURN ACTIVE STORE =============
// Replace your existing /api/user/me with this version:

app.get("/api/user/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, company_name, role, email_verified, created_at, last_login
       FROM users WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = result.rows[0];

    // Get user's active store from new connected_stores table
    const storeResult = await pool.query(
      `SELECT id, integration_name, store_name, store_origin, connected_at 
       FROM connected_stores 
       WHERE user_id = $1 AND is_active = true 
       LIMIT 1`,
      [req.user.userId]
    );

    // If no active store, get the most recent one
    let activeStore = null;
    if (storeResult.rows.length === 0) {
      const anyStore = await pool.query(
        `SELECT id, integration_name, store_name, store_origin, connected_at 
         FROM connected_stores 
         WHERE user_id = $1 
         ORDER BY connected_at DESC 
         LIMIT 1`,
        [req.user.userId]
      );
      if (anyStore.rows.length > 0) {
        activeStore = anyStore.rows[0];
        // Set it as active
        await pool.query(
          `UPDATE connected_stores SET is_active = true WHERE id = $1`,
          [activeStore.id]
        );
      }
    } else {
      activeStore = storeResult.rows[0];
    }

    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        companyName: user.company_name,
        role: user.role,
        emailVerified: user.email_verified,
        createdAt: user.created_at,
        lastLogin: user.last_login,
      },
      shop: activeStore ? {
        shopOrigin: activeStore.store_origin,
        installedAt: activeStore.connected_at,
        storeName: activeStore.store_name,
        integration: activeStore.integration_name
      } : null,
    });
  } catch (err) {
    console.error("Get user error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch user data" });
  }
});

// ============= SHOPIFY OVERVIEW =============
app.get("/api/shopify/overview", authenticateToken, async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ success: false, message: "Shop parameter required" });

    const accessToken = await getShopToken(shop, req.user.userId);
    const apiVersion = process.env.SHOPIFY_API_VERSION || "2024-01";
    const baseUrl = `https://${shop}/admin/api/${apiVersion}`;

    const [ordersResp, productsResp, customersResp] = await Promise.all([
      fetch(`${baseUrl}/orders.json?status=any&limit=250&created_at_min=${getDateDaysAgo(30)}`, { headers: { "X-Shopify-Access-Token": accessToken } }),
      fetch(`${baseUrl}/products.json?limit=250`, { headers: { "X-Shopify-Access-Token": accessToken } }),
      fetch(`${baseUrl}/customers.json?limit=250`, { headers: { "X-Shopify-Access-Token": accessToken } }),
    ]);

    const ordersList   = (await ordersResp.json()).orders    || [];
    const productsList = (await productsResp.json()).products || [];

    const totalRevenue     = ordersList.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const todayOrders      = ordersList.filter(o => isToday(new Date(o.created_at)));
    const yesterdayOrders  = ordersList.filter(o => isYesterday(new Date(o.created_at)));
    const lastMonthOrders  = ordersList.filter(o => isLastMonth(new Date(o.created_at)));
    const lastMonthRevenue = lastMonthOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const revenueChange    = lastMonthRevenue > 0 ? ((totalRevenue - lastMonthRevenue) / lastMonthRevenue * 100).toFixed(1) : 0;

    const allVariants = productsList.flatMap(p => p.variants || []);
    const outOfStock  = allVariants.filter(v => (v.inventory_quantity || 0) === 0);
    const lowStock    = allVariants.filter(v => (v.inventory_quantity || 0) > 0 && (v.inventory_quantity || 0) <= 10);
    const conversionRate = ((ordersList.length / Math.max(ordersList.length * 25, 1)) * 100).toFixed(1);

    return res.json({
      success: true,
      data: {
        revenue:    { total: totalRevenue.toFixed(2), change: revenueChange, lastMonth: lastMonthRevenue.toFixed(2) },
        orders:     { today: todayOrders.length, yesterday: yesterdayOrders.length, total: ordersList.length, change: yesterdayOrders.length > 0 ? (((todayOrders.length - yesterdayOrders.length) / yesterdayOrders.length) * 100).toFixed(1) : 0 },
        inventory:  { totalProducts: productsList.length, totalVariants: allVariants.length, outOfStock: outOfStock.length, lowStock: lowStock.length },
        conversion: { rate: conversionRate },
      }
    });
  } catch (err) {
    console.error("Overview error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ============= SHOPIFY ORDERS =============
app.get("/api/shopify/orders", authenticateToken, async (req, res) => {
  try {
    const shop  = req.query.shop;
    const limit = req.query.limit || 50;
    if (!shop) return res.status(400).json({ success: false, message: "Shop parameter required" });

    const accessToken = await getShopToken(shop, req.user.userId);
    const apiVersion  = process.env.SHOPIFY_API_VERSION || "2024-01";

    const response = await fetch(
      `https://${shop}/admin/api/${apiVersion}/orders.json?status=any&limit=${limit}&order=created_at+DESC`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );

    const data = await response.json();
    return res.json({ success: true, orders: data.orders || [] });
  } catch (err) {
    console.error("Orders error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ============= SHOPIFY INVENTORY =============
app.get("/api/shopify/inventory", authenticateToken, async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ success: false, message: "Shop parameter required" });

    const accessToken = await getShopToken(shop, req.user.userId);
    const apiVersion  = process.env.SHOPIFY_API_VERSION || "2024-01";

    const response = await fetch(
      `https://${shop}/admin/api/${apiVersion}/products.json?limit=250`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );

    const products = (await response.json()).products || [];
    const inventoryItems = [];

    products.forEach(product => {
      (product.variants || []).forEach(variant => {
        const quantity = variant.inventory_quantity || 0;
        inventoryItems.push({
          productId:    product.id,
          productTitle: product.title,
          variantId:    variant.id,
          variantTitle: variant.title,
          sku:          variant.sku,
          quantity,
          price:        variant.price,
          status:       quantity === 0 ? "out_of_stock" : quantity <= 10 ? "low_stock" : "in_stock",
        });
      });
    });

    inventoryItems.sort((a, b) => {
      if (a.status === "out_of_stock" && b.status !== "out_of_stock") return -1;
      if (b.status === "out_of_stock" && a.status !== "out_of_stock") return 1;
      if (a.status === "low_stock"    && b.status !== "low_stock")    return -1;
      if (b.status === "low_stock"    && a.status !== "low_stock")    return 1;
      return a.quantity - b.quantity;
    });

    return res.json({
      success: true,
      inventory: {
        items:         inventoryItems,
        outOfStock:    inventoryItems.filter(i => i.status === "out_of_stock"),
        lowStock:      inventoryItems.filter(i => i.status === "low_stock"),
        totalProducts: products.length,
        totalVariants: inventoryItems.length,
      }
    });
  } catch (err) {
    console.error("Inventory error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ============= SHOPIFY CUSTOMERS =============
app.get("/api/shopify/customers", authenticateToken, async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ success: false, message: "Shop parameter required" });

    const accessToken = await getShopToken(shop, req.user.userId);
    const apiVersion  = process.env.SHOPIFY_API_VERSION || "2024-01";

    const response = await fetch(
      `https://${shop}/admin/api/${apiVersion}/customers.json?limit=250`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );

    const customers       = (await response.json()).customers || [];
    const repeatCustomers = customers.filter(c => (c.orders_count || 0) > 1);
    const totalSpent      = customers.reduce((s, c) => s + parseFloat(c.total_spent || 0), 0);

    const topCustomers = [...customers]
      .sort((a, b) => parseFloat(b.total_spent || 0) - parseFloat(a.total_spent || 0))
      .slice(0, 10)
      .map(c => ({
        id:          c.id,
        name:        `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Guest",
        email:       c.email,
        ordersCount: c.orders_count || 0,
        totalSpent:  parseFloat(c.total_spent || 0).toFixed(2),
      }));

    return res.json({
      success: true,
      customers: {
        total:            customers.length,
        repeatCustomers:  repeatCustomers.length,
        repeatRate:       customers.length > 0 ? ((repeatCustomers.length / customers.length) * 100).toFixed(1) : 0,
        avgLifetimeValue: customers.length > 0 ? (totalSpent / customers.length).toFixed(2) : "0.00",
        topCustomers,
      }
    });
  } catch (err) {
    console.error("Customers error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ============= SHOPIFY ANALYTICS =============
app.get("/api/shopify/analytics", authenticateToken, async (req, res) => {
  try {
    const shop = req.query.shop;
    const days = parseInt(req.query.days) || 7;
    if (!shop) return res.status(400).json({ success: false, message: "Shop parameter required" });

    const accessToken = await getShopToken(shop, req.user.userId);
    const apiVersion  = process.env.SHOPIFY_API_VERSION || "2024-01";

    const response = await fetch(
      `https://${shop}/admin/api/${apiVersion}/orders.json?status=any&limit=250&created_at_min=${getDateDaysAgo(days)}`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );

    const orders = (await response.json()).orders || [];

    const dailyData = {};
    for (let i = 0; i < days; i++) {
      const date    = new Date();
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split("T")[0];
      dailyData[dateKey] = { revenue: 0, orders: 0, date: dateKey };
    }

    orders.forEach(order => {
      const dateKey = order.created_at.split("T")[0];
      if (dailyData[dateKey]) {
        dailyData[dateKey].revenue += parseFloat(order.total_price || 0);
        dailyData[dateKey].orders  += 1;
      }
    });

    const chartData = Object.values(dailyData)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map(d => ({
        date:    new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        revenue: parseFloat(d.revenue.toFixed(2)),
        orders:  d.orders,
      }));

    return res.json({ success: true, analytics: chartData });
  } catch (err) {
    console.error("Analytics error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ============= AI CHAT =============
app.post("/api/ai/chat", authenticateToken, async (req, res) => {
  try {
    const { message, shopOrigin } = req.body;
    if (!message)    return res.status(400).json({ success: false, message: "Message is required" });
    if (!shopOrigin) return res.status(400).json({ success: false, message: "Shop origin is required" });

    // Verify shop belongs to this user
    const shopCheck = await pool.query(
      `SELECT shop_origin FROM shops WHERE shop_origin = $1 AND (user_id = $2 OR user_id IS NULL)`,
      [shopOrigin, req.user.userId]
    );
    if (shopCheck.rows.length === 0) {
      return res.status(403).json({ success: false, message: "Shop not found for this account" });
    }

    // Fetch this user's Shopify data for AI context
    let shopContext = "";
    try {
      const accessToken = await getShopToken(shopOrigin, req.user.userId);
      const apiVersion  = process.env.SHOPIFY_API_VERSION || "2024-01";
      const base        = `https://${shopOrigin}/admin/api/${apiVersion}`;
      const h           = { "X-Shopify-Access-Token": accessToken };

      const since    = new Date();
      since.setDate(since.getDate() - 180);

      const [ordersRes, productsRes, customersRes] = await Promise.all([
        fetch(`${base}/orders.json?status=any&limit=250&created_at_min=${since.toISOString()}`, { headers: h }),
        fetch(`${base}/products.json?limit=250`,  { headers: h }),
        fetch(`${base}/customers.json?limit=250`, { headers: h }),
      ]);

      const orders    = (await ordersRes.json()).orders      || [];
      const products  = (await productsRes.json()).products  || [];
      const customers = (await customersRes.json()).customers || [];

      // Build product sales summary
      const productSales = {};
      orders.forEach(order => {
        (order.line_items || []).forEach(item => {
          if (!productSales[item.title]) productSales[item.title] = { units: 0, revenue: 0 };
          productSales[item.title].units   += item.quantity;
          productSales[item.title].revenue += parseFloat(item.price) * item.quantity;
        });
      });

      const topProducts = Object.entries(productSales)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, 15)
        .map(([name, s]) => `  - ${name}: ${s.units} units sold, $${s.revenue.toFixed(2)} revenue`);

      // Monthly revenue
      const monthly = {};
      orders.forEach(o => {
        const m = o.created_at.slice(0, 7);
        if (!monthly[m]) monthly[m] = 0;
        monthly[m] += parseFloat(o.total_price || 0);
      });
      const monthlyLines = Object.entries(monthly)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([m, r]) => `  - ${m}: $${r.toFixed(2)}`);

      // Inventory alerts
      const invAlerts = [];
      products.forEach(p => {
        (p.variants || []).forEach(v => {
          const qty = v.inventory_quantity || 0;
          if (qty <= 10) invAlerts.push(`  - ${p.title}${v.title !== "Default Title" ? ` (${v.title})` : ""}: ${qty} units${qty === 0 ? " [OUT OF STOCK]" : " [LOW]"}`);
        });
      });

      const totalRevenue    = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
      const avgOrderVal     = orders.length ? totalRevenue / orders.length : 0;
      const repeatCustomers = customers.filter(c => (c.orders_count || 0) > 1);
      const totalSpent      = customers.reduce((s, c) => s + parseFloat(c.total_spent || 0), 0);
      const refunded        = orders.filter(o => o.financial_status === "refunded" || o.financial_status === "partially_refunded");

      shopContext = `
MERCHANT STORE: ${shopOrigin}
DATA PERIOD: Last 180 days

=== SALES OVERVIEW ===
Total Orders: ${orders.length}
Total Revenue: $${totalRevenue.toFixed(2)}
Average Order Value: $${avgOrderVal.toFixed(2)}
Refund Rate: ${orders.length ? ((refunded.length / orders.length) * 100).toFixed(1) : 0}%

=== MONTHLY REVENUE ===
${monthlyLines.join("\n") || "  No data"}

=== TOP PRODUCTS BY REVENUE ===
${topProducts.join("\n") || "  No sales data yet"}

=== INVENTORY ALERTS (10 units or fewer) ===
${invAlerts.length > 0 ? invAlerts.join("\n") : "  All products well stocked"}

=== CUSTOMERS ===
Total: ${customers.length}
Repeat Customers: ${repeatCustomers.length} (${customers.length ? ((repeatCustomers.length / customers.length) * 100).toFixed(1) : 0}%)
Avg Lifetime Value: $${customers.length ? (totalSpent / customers.length).toFixed(2) : "0.00"}
`.trim();

    } catch (shopErr) {
      console.error("Shopify context error:", shopErr);
      shopContext = "Store data temporarily unavailable. Answering based on general e-commerce best practices.";
    }

    // Call Claude
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response  = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `You are Aervo, an expert AI business analyst and co-pilot for Shopify merchants.
You have real-time data from this merchant's Shopify store. Your job is to:
- Answer questions accurately using their actual store data
- Give specific, actionable recommendations
- Be concise but insightful — like a trusted advisor
- Suggest specific numbers (discount %, reorder quantities, etc.) based on the data
- Format numbers clearly ($1,234.56 not 1234.56)
- Keep responses focused and practical

STORE DATA:
${shopContext}`,
      messages: [{ role: "user", content: message }],
    });

    return res.json({ success: true, reply: response.content[0]?.text || "Sorry, I could not generate a response." });

  } catch (err) {
    console.error("AI chat error:", err);
    return res.status(500).json({ success: false, message: "AI assistant failed. Please try again." });
  }
});

// ============= INSIGHTS (legacy endpoint) =============
app.get("/insights", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ success: false, message: "Missing shop" });

    const dbRes = await pool.query("SELECT access_token FROM shops WHERE shop_origin = $1", [shop]);
    if (dbRes.rows.length === 0) return res.status(404).json({ success: false, message: "Shop not found." });

    const accessToken = dbRes.rows[0].access_token;
    const apiVersion  = process.env.SHOPIFY_API_VERSION || "2024-01";
    const baseUrl     = `https://${shop}/admin/api/${apiVersion}`;

    const [shopResp, ordersResp] = await Promise.all([
      fetch(`${baseUrl}/shop.json`,                          { headers: { "X-Shopify-Access-Token": accessToken } }),
      fetch(`${baseUrl}/orders.json?status=any&limit=10`,    { headers: { "X-Shopify-Access-Token": accessToken } }),
    ]);

    if (!shopResp.ok)   return res.status(shopResp.status).json({ success: false, message: "Shopify shop.json failed" });
    if (!ordersResp.ok) return res.status(ordersResp.status).json({ success: false, message: "Shopify orders.json failed" });

    const shopJson   = await shopResp.json();
    const ordersJson = await ordersResp.json();

    return res.json({ success: true, shopName: shopJson.shop?.name || null, recentOrders: ordersJson.orders || [] });
  } catch (err) {
    console.error("Insights error:", err);
    return res.status(500).json({ success: false, message: "Insights failed" });
  }
});

// ============= TEST EMAIL =============
app.get("/api/test-email", async (req, res) => {
  const to = req.query.to || process.env.TEST_EMAIL;
  try {
    await sendWelcomeEmail({ toEmail: to, companyName: "Aervo Test Company" });
    res.json({ ok: true, message: `Test welcome email sent to ${to}` });
  } catch (err) {
    console.error("Test email failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============= SIGNUP =============
app.post("/api/signup", authLimiter, async (req, res) => {
  try {
    const { email, password, companyName } = req.body;
    if (!email || !password || !companyName) {
      return res.status(400).json({ success: false, message: "Email, password, and company name are required." });
    }

    const normalizedEmail = String(email).toLowerCase();
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }

    const saltRounds  = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const { token: verifyToken, tokenHash } = createVerifyToken();
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const insertResult = await pool.query(
      `INSERT INTO users (email, password_hash, company_name, role, email_verified, verify_token_hash, verify_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, company_name, role`,
      [normalizedEmail, passwordHash, companyName, "Owner", false, tokenHash, verifyExpiresAt]
    );

    const user  = insertResult.rows[0];
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

    sendVerifyEmail({ toEmail: normalizedEmail, token: verifyToken })
      .catch(err => console.error("Verify email failed:", err));

    return res.json({
      success: true, token,
      user: { id: user.id, email: user.email, companyName: user.company_name, role: user.role },
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ success: false, message: "Error creating account. Please try again." });
  }
});

// ============= VERIFY EMAIL =============
app.get("/api/verify-email", async (req, res) => {
  try {
    const token           = String(req.query.token || "");
    const normalizedEmail = String(req.query.email || "").toLowerCase();
    if (!token || !normalizedEmail) return res.status(400).send("Invalid verification link.");

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const result = await pool.query(
      `SELECT id, email_verified, verify_expires_at, company_name FROM users WHERE email = $1 AND verify_token_hash = $2`,
      [normalizedEmail, tokenHash]
    );

    if (result.rows.length === 0) return res.status(400).send("Invalid or expired verification link.");

    const user = result.rows[0];
    if (user.email_verified) return res.redirect("https://aervoapp.com/login.html?verified=1");
    if (user.verify_expires_at && new Date(user.verify_expires_at) < new Date()) return res.status(400).send("Verification link expired.");

    await pool.query(
      `UPDATE users SET email_verified = TRUE, verify_token_hash = NULL, verify_expires_at = NULL WHERE id = $1`,
      [user.id]
    );

    sendWelcomeEmail({ toEmail: normalizedEmail, companyName: user.company_name })
      .catch(err => console.error("Welcome email failed:", err));

    return res.redirect("https://aervoapp.com/login.html?verified=1");
  } catch (err) {
    console.error("Verify email error:", err);
    return res.status(500).send("Verification failed.");
  }
});

// ============= LOGIN =============
app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const normalizedEmail = String(email).toLowerCase();
    const result = await pool.query(
      "SELECT id, email, password_hash, company_name, role, email_verified FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (result.rows.length === 0) return res.status(401).json({ success: false, message: "Invalid credentials." });

    const user = result.rows[0];
    if (!user.email_verified) {
      return res.status(403).json({ success: false, message: "Please verify your email before logging in." });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ success: false, message: "Invalid credentials." });

    await pool.query("UPDATE users SET last_login = NOW() WHERE id = $1", [user.id]);

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      success: true, token,
      user: { id: user.id, email: user.email, companyName: user.company_name, role: user.role },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, message: "Server error during login." });
  }
});

// ============= FORGOT PASSWORD =============
app.post("/api/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email is required." });

  try {
    const normalizedEmail = String(email).toLowerCase();
    const result = await pool.query("SELECT id, email, company_name FROM users WHERE email = $1", [normalizedEmail]);

    if (result.rows.length === 0) {
      return res.json({ success: true, message: "If an account exists, we sent a reset link." });
    }

    const user      = result.rows[0];
    const token     = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60);

    await pool.query(
      `UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3`,
      [token, expiresAt, user.id]
    );

    await sendPasswordResetEmail({ toEmail: user.email, companyName: user.company_name, token });

    return res.json({ success: true, message: "If an account exists, we sent a reset link." });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ success: false, message: "Something went wrong." });
  }
});

// ============= RESET PASSWORD =============
app.post("/api/reset-password", authLimiter, async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ success: false, message: "Token and new password are required." });
  }

  try {
    const result = await pool.query(
      `SELECT id, email FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid or expired reset link." });
    }

    const user   = result.rows[0];
    const hashed = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2`,
      [hashed, user.id]
    );

    return res.json({ success: true, message: "Password updated successfully." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ success: false, message: "Something went wrong." });
  }
});

// ============= START SERVER =============
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});