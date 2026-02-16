// routes/shopify.js
const express = require("express");
const crypto = require("crypto");
const { shopify } = require("../utils/shopify");

module.exports = function (pool) {
  const router = express.Router();

  // ============= SHOPIFY OAUTH START =============
  router.get("/", async (req, res) => {
    try {
      const shop = String(req.query.shop || "").trim();

      if (!shop) {
        return res.status(400).send("Missing shop parameter");
      }

      // Validate shop format
      if (!shop.match(/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/)) {
        return res.status(400).send("Invalid shop domain format");
      }

      // Generate and store OAuth state
      const state = crypto.randomBytes(16).toString("hex");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

      await pool.query(
        `INSERT INTO shopify_oauth_states (shop_origin, state, created_at) 
         VALUES ($1, $2, NOW())`,
        [shop, state]
      );

      // Clean up old states (older than 15 minutes)
      await pool.query(
        `DELETE FROM shopify_oauth_states 
         WHERE created_at < NOW() - INTERVAL '15 minutes'`
      );

      const redirectUri = `${process.env.APP_URL}/auth/shopify/callback`;
      const scopes = process.env.SHOPIFY_SCOPES || "read_products,read_orders,read_inventory";

      const authUrl = `https://${shop}/admin/oauth/authorize?` +
        `client_id=${process.env.SHOPIFY_API_KEY}&` +
        `scope=${scopes}&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `state=${state}`;

      return res.redirect(authUrl);
    } catch (err) {
      console.error("Shopify OAuth initiation error:", err);
      return res.status(500).send("Failed to initiate OAuth");
    }
  });

  // ============= SHOPIFY OAUTH CALLBACK =============
  router.get("/callback", async (req, res) => {
    try {
      const { shop, code, state, hmac } = req.query;

      if (!shop || !code || !state) {
        return res.status(400).send("Missing required OAuth parameters");
      }

      // Verify state
      const stateCheck = await pool.query(
        `SELECT id FROM shopify_oauth_states 
         WHERE shop_origin = $1 AND state = $2 
         AND created_at > NOW() - INTERVAL '15 minutes'`,
        [shop, state]
      );

      if (stateCheck.rows.length === 0) {
        return res.status(400).send("Invalid or expired OAuth state");
      }

      // Verify HMAC
      if (!verifyHmac(req.query)) {
        return res.status(400).send("HMAC validation failed");
      }

      // Exchange code for access token
      const tokenResponse = await fetch(
        `https://${shop}/admin/oauth/access_token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: process.env.SHOPIFY_API_KEY,
            client_secret: process.env.SHOPIFY_API_SECRET,
            code,
          }),
        }
      );

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error("Token exchange failed:", errorText);
        return res.status(500).send("Failed to exchange OAuth code for token");
      }

      const tokenData = await tokenResponse.json();

      if (!tokenData.access_token) {
        return res.status(500).send("No access token received");
      }

      // Store the shop connection
      await pool.query(
        `INSERT INTO shops (shop_origin, access_token, scope, installed_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (shop_origin) 
         DO UPDATE SET access_token = $2, scope = $3, installed_at = NOW()`,
        [shop, tokenData.access_token, tokenData.scope]
      );

      // Clean up used state
      await pool.query(
        `DELETE FROM shopify_oauth_states WHERE state = $1`,
        [state]
      );

      console.log(`✅ Shopify store ${shop} connected successfully`);

      // Redirect to dashboard with success
      const frontendUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
      return res.redirect(`${frontendUrl}/dashboard.html?shop=${encodeURIComponent(shop)}&connected=1`);
    } catch (err) {
      console.error("Shopify OAuth callback error:", err);
      return res.status(500).send("OAuth callback failed");
    }
  });

  // Helper function to verify Shopify HMAC
  function verifyHmac(query) {
    const { hmac, signature, ...params } = query;

    if (!hmac) return false;

    const message = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("&");

    const generatedHash = crypto
      .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(message)
      .digest("hex");

    try {
      return crypto.timingSafeEqual(
        Buffer.from(generatedHash),
        Buffer.from(hmac)
      );
    } catch {
      return false;
    }
  }

  return router;
};