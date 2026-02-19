// backend/routes/shopify.js
// UPDATED: Saves to connected_stores table for multi-store support

const express = require("express");
const crypto  = require("crypto");
const fetch   = require("node-fetch");

module.exports = function (pool) {
  const router = express.Router();

  const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY;
  const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
  const SHOPIFY_SCOPES     = process.env.SHOPIFY_SCOPES || "read_products,read_orders,read_customers,read_inventory";
  const APP_URL            = process.env.APP_URL;
  const FRONTEND_URL       = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
  const JWT_SECRET         = process.env.JWT_SECRET || "dev_secret_key_change_me";

  const jwt = require("jsonwebtoken");

function getUserIdFromToken(req) {
  try {
    // Try to get token from Authorization header first
    let authHeader = req.headers["authorization"];
    let token = authHeader && authHeader.split(" ")[1];
    
    // If not in header, check query params (for OAuth flow from integrations page)
    if (!token && req.query && req.query.token) {
      token = req.query.token;
      console.log("🔍 Got token from query params, length:", token.length);
    }
    
    if (!token) {
      console.log("❌ No token found in header or query");
      return null;
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log("✅ Token decoded, userId:", decoded.userId);
    return decoded.userId || null;
  } catch (err) {
    console.error("❌ Token verification failed:", err.message);
    return null;
  }
}
// POST endpoint to initiate OAuth (receives token securely)
router.post("/initiate", express.json(), express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { shop, token } = req.body;
    
    console.log("🔍 POST initiate - shop:", shop);
    console.log("🔍 POST initiate - token:", token ? `${token.substring(0, 30)}...` : "NULL");
    
    if (!shop || !shop.endsWith(".myshopify.com")) {
      return res.status(400).send("Invalid shop domain.");
    }
    
    if (!token) {
      return res.status(401).send("Authentication required.");
    }
    
    // Verify token
    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.userId;
      console.log("✅ Token verified, userId:", userId);
    } catch (err) {
      console.log("❌ Invalid token:", err.message);
      return res.status(401).send("Invalid authentication token.");
    }
    
    const state = crypto.randomBytes(16).toString("hex");
    
    await pool.query(
      `INSERT INTO shopify_oauth_states (shop_origin, state, user_id, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [shop, state, userId]
    );
    
    const redirectUri = `${APP_URL}/auth/shopify/callback`;
    const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    
    return res.redirect(installUrl);
  } catch (err) {
    console.error("OAuth initiate error:", err);
    return res.status(500).send("OAuth failed to start.");
  }
});

router.get("/", async (req, res) => {
  try {
    console.log("🔍 OAuth initiation request received");
    console.log("Query params:", req.query);
    console.log("Token in query:", req.query.token ? `${req.query.token.substring(0, 30)}...` : "NULL");
    
    const shop = String(req.query.shop || "").trim().toLowerCase();
   

    if (!shop || !shop.endsWith(".myshopify.com")) {
      return res.status(400).send("Invalid shop domain.");
    }

    const state = crypto.randomBytes(16).toString("hex");
    
    // Get userId from token in query params OR header
    let userId = getUserIdFromToken(req);
    
    console.log("🔍 OAuth initiation - userId:", userId);  // ADD THIS LOG
    
    if (!userId) {
      console.log("❌ No userId found - user not authenticated");
      return res.status(401).send("Authentication required. Please log in first.");
    }

    await pool.query(
      `INSERT INTO shopify_oauth_states (shop_origin, state, user_id, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [shop, state, userId]
    );

    const redirectUri  = `${APP_URL}/auth/shopify/callback`;
    const installUrl   = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

    return res.redirect(installUrl);
  } catch (err) {
    console.error("OAuth initiation error:", err);
    return res.status(500).send("OAuth failed to start.");
  }
});

  router.get("/callback", async (req, res) => {
  try {
    console.log("🔍 OAuth callback started");
    const { shop, code, state, hmac } = req.query;
    console.log("Shop:", shop, "State:", state);

    if (!shop || !code || !state || !hmac) {
      console.log("❌ Missing OAuth params");
      return res.status(400).send("Missing required OAuth parameters.");
    }

    // Verify HMAC
    console.log("Verifying HMAC...");
    const queryParams = Object.entries(req.query)
      .filter(([key]) => key !== "hmac")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");

    const expectedHmac = crypto
      .createHmac("sha256", SHOPIFY_API_SECRET)
      .update(queryParams)
      .digest("hex");

    if (expectedHmac !== hmac) {
      console.log("❌ Invalid HMAC");
      return res.status(401).send("Invalid HMAC.");
    }
    console.log("✅ HMAC verified");

    // Verify state
    console.log("Verifying state...");
    const stateResult = await pool.query(
      `SELECT user_id FROM shopify_oauth_states
       WHERE shop_origin = $1 AND state = $2 AND created_at > NOW() - INTERVAL '10 minutes'`,
      [shop, state]
    );

    console.log("State result rows:", stateResult.rows.length);

    if (stateResult.rows.length === 0) {
      console.log("❌ Invalid or expired state");
      return res.status(400).send("Invalid or expired OAuth state.");
    }

    const userId = stateResult.rows[0].user_id;
    console.log("✅ UserId from state:", userId);

    await pool.query(
      `DELETE FROM shopify_oauth_states WHERE shop_origin = $1 AND state = $2`,
      [shop, state]
    );
    console.log("✅ State deleted");

    // Exchange code for access token
    console.log("Exchanging code for token...");
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id:     SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    console.log("Token response status:", tokenResponse.status);

    if (!tokenResponse.ok) {
      console.log("❌ Failed to exchange code");
      return res.status(500).send("Failed to exchange OAuth code.");
    }

    const tokenData = await tokenResponse.json();
    const { access_token, scope } = tokenData;
    console.log("✅ Got access token");

    // Save to OLD shops table for backwards compatibility
    console.log("💾 Saving to shops table...");
    await pool.query(
      `INSERT INTO shops (shop_origin, access_token, scope, user_id, store_name, installed_at)
       VALUES ($1, $2, $3, $4, $1, NOW())
       ON CONFLICT (shop_origin)
       DO UPDATE SET
         access_token = EXCLUDED.access_token,
         scope        = EXCLUDED.scope,
         user_id      = EXCLUDED.user_id,
         installed_at = NOW()`,
      [shop, access_token, scope, userId]
    );
    console.log("✅ Saved to shops");

    // Save to NEW connected_stores table (multi-store support)
    console.log("💾 Saving to connected_stores...");
    console.log("Parameters:", {
      userId,
      shopString: String(shop),
      tokenLength: String(access_token).length
    });
    
    await pool.query(
      `INSERT INTO connected_stores (
         user_id, integration_name, store_id, store_name, 
         store_origin, access_token, is_active, connected_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, integration_name, store_id)
       DO UPDATE SET
         access_token = EXCLUDED.access_token,
         is_active    = EXCLUDED.is_active,
         updated_at   = NOW()`,
      [
        userId,                    // $1
        'shopify',                 // $2
        String(shop),              // $3
        String(shop),              // $4
        String(shop),              // $5
        String(access_token),      // $6
        true                       // $7
      ]
    );
    console.log("✅ Saved to connected_stores");

    // Mark all other stores for this user as inactive
    console.log("Setting other stores inactive...");
    await pool.query(
      `UPDATE connected_stores 
       SET is_active = false 
       WHERE user_id = $1 AND store_id != $2`,
      [userId, shop]
    );
    console.log("✅ Other stores set to inactive");

    console.log(`✅ Shop ${shop} connected to user ${userId}`);

    return res.redirect(`${FRONTEND_URL}/integrations.html?connected=1`);

  } catch (err) {
    console.error("❌ OAuth callback error:", err);
    return res.status(500).send("OAuth callback failed.");
  }
});
  return router;
};