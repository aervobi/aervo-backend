// backend/routes/shopify.js
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

  router.get("/", async (req, res) => {
    try {
      const shop = String(req.query.shop || "").trim().toLowerCase();

      if (!shop || !shop.endsWith(".myshopify.com")) {
        return res.status(400).send("Invalid shop domain.");
      }

      const state = crypto.randomBytes(16).toString("hex");

      await pool.query(
        `INSERT INTO shopify_oauth_states (shop_origin, state, created_at)
         VALUES ($1, $2, NOW())`,
        [shop, state]
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
        `SELECT * FROM shopify_oauth_states
         WHERE shop_origin = $1 AND state = $2 AND created_at > NOW() - INTERVAL '10 minutes'`,
        [shop, state]
      );

      if (stateResult.rows.length === 0) {
        return res.status(400).send("Invalid or expired OAuth state.");
      }

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

      await pool.query(
        `INSERT INTO shops (shop_origin, access_token, scope, store_name, installed_at)
         VALUES ($1::text, $2::text, $3::text, $1::text, NOW())
         ON CONFLICT (shop_origin)
         DO UPDATE SET
           access_token = EXCLUDED.access_token,
           scope        = EXCLUDED.scope,
           installed_at = NOW()`,
        [shop, access_token, scope]
      );

      // ALSO save to connected_stores for dashboard
      // Get the user_id from the shop (you'll need to query for this)
      // For now, let's just insert without user_id
      await pool.query(
        `INSERT INTO connected_stores (
           integration_name, store_id, store_name, store_origin, 
           access_token, is_active, connected_at
         )
         VALUES ($1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::text, true, NOW())
         ON CONFLICT (integration_name, store_id) 
         DO UPDATE SET
           access_token = EXCLUDED.access_token,
           is_active = true,
           updated_at = NOW()`,
        ['shopify', shop, shop, shop, access_token]
      );

      console.log(`✅ Shop ${shop} connected successfully`);

      return res.redirect(`${FRONTEND_URL}/dashboard.html?connected=1`);

    } catch (err) {
      console.error("OAuth callback error:", err);
      return res.status(500).send("OAuth callback failed.");
    }
  });

  return router;
};