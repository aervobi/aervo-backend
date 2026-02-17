// backend/routes/shopify.js
// UPDATED: saves user_id when a Shopify store connects
// so each shop is permanently linked to the merchant account

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

  // ============= HELPER: Get user from JWT =============
  // Extracts userId from the JWT token if present
  // Returns null if no token (merchant not logged in yet)
  function getUserIdFromToken(req) {
    try {
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];
      if (!token) return null;
      const decoded = jwt.verify(token, JWT_SECRET);
      return decoded.userId || null;
    } catch {
      return null;
    }
  }

  // ============= STEP 1: Initiate OAuth =============
  // Merchant clicks "Connect Shopify" → we redirect them to Shopify
  router.get("/", async (req, res) => {
    try {
      const shop = String(req.query.shop || "").trim().toLowerCase();

      if (!shop || !shop.endsWith(".myshopify.com")) {
        return res.status(400).send("Invalid shop domain.");
      }

      // Generate a secure random state for CSRF protection
      const state = crypto.randomBytes(16).toString("hex");

      // Get the userId from JWT if the merchant is logged in
      // This links their Aervo account to their Shopify store
      const userId = getUserIdFromToken(req);

      // Save state + userId in DB so we can retrieve it in the callback
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

  // ============= STEP 2: OAuth Callback =============
  // Shopify redirects back here after merchant approves
  router.get("/callback", async (req, res) => {
    try {
      const { shop, code, state, hmac } = req.query;

      if (!shop || !code || !state || !hmac) {
        return res.status(400).send("Missing required OAuth parameters.");
      }

      // ---- Verify HMAC ----
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
        return res.status(401).send("Invalid HMAC. Request may have been tampered with.");
      }

      // ---- Verify state and get userId ----
      const stateResult = await pool.query(
        `SELECT user_id FROM shopify_oauth_states
         WHERE shop_origin = $1 AND state = $2 AND created_at > NOW() - INTERVAL '10 minutes'`,
        [shop, state]
      );

      if (stateResult.rows.length === 0) {
        return res.status(400).send("Invalid or expired OAuth state.");
      }

      const userId = stateResult.rows[0].user_id;

      // Clean up the used state
      await pool.query(
        `DELETE FROM shopify_oauth_states WHERE shop_origin = $1 AND state = $2`,
        [shop, state]
      );

      // ---- Exchange code for access token ----
      const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id:     SHOPIFY_API_KEY,
          client_secret: SHOPIFY_API_SECRET,
          code,
        }),
      });

      if (!tokenResponse.ok) {
        return res.status(500).send("Failed to exchange OAuth code for access token.");
      }

      const tokenData = await tokenResponse.json();
      const { access_token, scope } = tokenData;

      // ---- Save shop + link to user ----
      // If the shop already exists (reinstall), update it and link to user
      await pool.query(
        `INSERT INTO shops (shop_origin, access_token, scope, user_id, installed_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (shop_origin)
         DO UPDATE SET
           access_token = EXCLUDED.access_token,
           scope        = EXCLUDED.scope,
           user_id      = EXCLUDED.user_id,
           installed_at = NOW()`,
        [shop, access_token, scope, userId]
      );

      console.log(`✅ Shop ${shop} connected${userId ? ` to user ${userId}` : " (no user)"}`);

      // ---- Redirect back to dashboard ----
      return res.redirect(`${FRONTEND_URL}/dashboard.html?shop=${shop}&connected=1`);

    } catch (err) {
      console.error("OAuth callback error:", err);
      return res.status(500).send("OAuth callback failed.");
    }
  });

  return router;
};