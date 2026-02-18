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
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];
      if (!token) return null;
      const decoded = jwt.verify(token, JWT_SECRET);
      return decoded.userId || null;
    } catch {
      return null;
    }
  }

  router.get("/", async (req, res) => {
    try {
      const shop = String(req.query.shop || "").trim().toLowerCase();

      if (!shop || !shop.endsWith(".myshopify.com")) {
        return res.status(400).send("Invalid shop domain.");
      }

      const state = crypto.randomBytes(16).toString("hex");
      const userId = getUserIdFromToken(req);

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
      const { shop, code, state, hmac } = req.query;

      if (!shop || !code || !state || !hmac) {
        return res.status(400).send("Missing required OAuth parameters.");
      }

      // Verify HMAC
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
        return res.status(401).send("Invalid HMAC.");
      }

      // Verify state
      const stateResult = await pool.query(
        `SELECT user_id FROM shopify_oauth_states
         WHERE shop_origin = $1 AND state = $2 AND created_at > NOW() - INTERVAL '10 minutes'`,
        [shop, state]
      );

      if (stateResult.rows.length === 0) {
        return res.status(400).send("Invalid or expired OAuth state.");
      }

      const userId = stateResult.rows[0].user_id;

      await pool.query(
        `DELETE FROM shopify_oauth_states WHERE shop_origin = $1 AND state = $2`,
        [shop, state]
      );

      // Exchange code for access token
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
        return res.status(500).send("Failed to exchange OAuth code.");
      }

      const tokenData = await tokenResponse.json();
      const { access_token, scope } = tokenData;

      // Save to OLD shops table for backwards compatibility
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

    // Save to NEW connected_stores table (multi-store support)
await pool.query(
  `INSERT INTO connected_stores (
     user_id, integration_name, store_id, store_name, 
     store_origin, access_token, is_active, connected_at
   )
   VALUES ($1::integer, 'shopify', $2::varchar, $3::varchar, $2::varchar, $4::text, true, NOW())
   ON CONFLICT (user_id, integration_name, store_id)
   DO UPDATE SET
     access_token = EXCLUDED.access_token,
     is_active    = EXCLUDED.is_active,
     updated_at   = NOW()`,
  [userId, shop, shop, access_token]
);

      // Mark all other stores for this user as inactive (only one active at a time)
      await pool.query(
        `UPDATE connected_stores 
         SET is_active = false 
         WHERE user_id = $1 AND store_id != $2`,
        [userId, shop]
      );

      console.log(`✅ Shop ${shop} connected to user ${userId}`);

      return res.redirect(`${FRONTEND_URL}/integrations.html?connected=1`);

    } catch (err) {
      console.error("OAuth callback error:", err);
      return res.status(500).send("OAuth callback failed.");
    }
  });

  return router;
};