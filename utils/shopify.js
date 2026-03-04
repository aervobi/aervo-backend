// routes/shopify.js (UPDATED)
// Adds mandatory compliance webhooks + app/uninstalled registration on install

const express = require("express");
const crypto = require("crypto");

module.exports = function (pool) {
  const router = express.Router();

  const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";
  const APP_URL = process.env.APP_URL; // must be https
  const FRONTEND_URL = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";

  // ============= SHOPIFY OAUTH START =============
  router.get("/", async (req, res) => {
    try {
      const shop = String(req.query.shop || "").trim().toLowerCase();

      if (!shop) return res.status(400).send("Missing shop parameter");

      // Validate shop format
      if (!shop.match(/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/)) {
        return res.status(400).send("Invalid shop domain format");
      }

      // Generate and store OAuth state
      const state = crypto.randomBytes(16).toString("hex");

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
      const scopes =
        process.env.SHOPIFY_SCOPES ||
        "read_products,read_orders,read_customers,read_inventory";

      const authUrl =
        `https://${shop}/admin/oauth/authorize?` +
        `client_id=${process.env.SHOPIFY_API_KEY}&` +
        `scope=${encodeURIComponent(scopes)}&` +
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
      const shop = String(req.query.shop || "").trim().toLowerCase();
      const code = String(req.query.code || "").trim();
      const state = String(req.query.state || "").trim();

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
      const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_API_KEY,
          client_secret: process.env.SHOPIFY_API_SECRET,
          code,
        }),
      });

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
      await pool.query(`DELETE FROM shopify_oauth_states WHERE state = $1`, [state]);

      // ✅ Register required webhooks (GDPR + app/uninstalled)
      await registerRequiredWebhooks(shop, tokenData.access_token);

      console.log(`✅ Shopify store ${shop} connected + webhooks registered`);

      return res.redirect(
        `${FRONTEND_URL}/dashboard.html?shop=${encodeURIComponent(shop)}&connected=1`
      );
    } catch (err) {
      console.error("Shopify OAuth callback error:", err);
      return res.status(500).send("OAuth callback failed");
    }
  });

  // =========================
  // WEBHOOK REGISTRATION
  // =========================

  async function registerRequiredWebhooks(shop, accessToken) {
    if (!APP_URL) {
      console.warn("⚠️ APP_URL missing, cannot register webhooks.");
      return;
    }

    const base = `${APP_URL}/webhooks/shopify`;

    const hooks = [
      { topic: "customers/data_request", address: `${base}/customers_data_request` },
      { topic: "customers/redact", address: `${base}/customers_redact` },
      { topic: "shop/redact", address: `${base}/shop_redact` },
      { topic: "app/uninstalled", address: `${base}/app_uninstalled` },
    ];

    for (const h of hooks) {
      await registerWebhook(shop, accessToken, h.topic, h.address);
    }
  }

  async function registerWebhook(shop, accessToken, topic, address) {
    try {
      const resp = await fetch(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            webhook: { topic, address, format: "json" },
          }),
        }
      );

      const text = await resp.text();

      if (!resp.ok) {
        // Don’t fail install if a webhook already exists or Shopify returns 422/409 style responses
        console.warn(`⚠️ Webhook register failed: ${topic} (${resp.status}) ${text}`);
        return;
      }

      console.log(`✅ Webhook registered: ${topic} -> ${address}`);
    } catch (err) {
      console.warn(`⚠️ Webhook register error (${topic}):`, err);
    }
  }

  // =========================
  // Helper function to verify Shopify HMAC (OAuth callback)
  // =========================
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
      // timingSafeEqual requires equal length buffers
      const a = Buffer.from(generatedHash, "utf8");
      const b = Buffer.from(String(hmac), "utf8");
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  return router;
};