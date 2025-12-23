const express = require("express");
const crypto = require("crypto");
const { shopify } = require("../utils/shopify");

function buildAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.HOST) return `https://${process.env.HOST.replace(/\/$/, "")}`;
  return "";
}

// Helper to verify OAuth HMAC (Shopify sends hmac param in callback)
function verifyHmac(query, secret) {
  const params = { ...query };
  delete params.hmac;
  delete params.signature; // legacy

  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  const hmac = crypto.createHmac("sha256", secret).update(sorted).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(query.hmac, "hex"));
}

module.exports = function mountShopifyRoutes(app, pool) {
  const router = express.Router();

  // Start OAuth install flow: /shopify/install?shop=storename.myshopify.com
  router.get("/install", async (req, res) => {
    const shop = req.query.shop;
    if (!shop) return res.status(400).send("Missing shop parameter");

    try {
      const state = crypto.randomBytes(16).toString("hex");
      res.cookie("shopify_oauth_state", state, { httpOnly: true, secure: process.env.NODE_ENV === "production", maxAge: 60000 });

      const redirectUri = `${buildAppUrl()}/shopify/callback`;
      const scopes = (process.env.SHOPIFY_SCOPES || "read_products").replace(/\s+/g,"");

      const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(process.env.SHOPIFY_API_KEY || "")}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

      return res.redirect(installUrl);
    } catch (err) {
      console.error("Shopify install begin failed:", err);
      return res.status(500).send("Failed to start Shopify OAuth");
    }
  });

  // OAuth callback
  router.get("/callback", async (req, res) => {
    try {
      const { shop, hmac, code, state } = req.query;
      const cookieState = req.cookies ? req.cookies.shopify_oauth_state : null;

      if (!shop || !hmac || !code || !state) return res.status(400).send("Missing required OAuth parameters");
      if (!cookieState || cookieState !== state) return res.status(400).send("Invalid OAuth state");

      // Validate HMAC
      if (!verifyHmac(req.query, process.env.SHOPIFY_API_SECRET || "")) {
        console.error("Invalid OAuth HMAC");
        return res.status(400).send("Invalid HMAC");
      }

      // Exchange code for access token
      const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_API_KEY,
          client_secret: process.env.SHOPIFY_API_SECRET,
          code,
        }),
      });

      if (!tokenResp.ok) {
        const text = await tokenResp.text();
        console.error("Failed to fetch access token:", text);
        return res.status(500).send("Failed to obtain access token");
      }

      const tokenJson = await tokenResp.json();
      const accessToken = tokenJson.access_token;
      const scope = tokenJson.scope;

      // Persist shop + token (upsert)
      await pool.query(
        `
          INSERT INTO shops (shop_origin, access_token, scope, installed_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (shop_origin) DO UPDATE
            SET access_token = EXCLUDED.access_token,
                scope = EXCLUDED.scope,
                installed_at = NOW()
        `,
        [shop, accessToken, scope]
      );

      // Redirect back to app or show success
      const appUrl = buildAppUrl() || "/";
      return res.redirect(`${appUrl}?shop_installed=${encodeURIComponent(shop)}`);
    } catch (err) {
      console.error("Shopify callback error:", err);
      return res.status(500).send("OAuth callback failed");
    }
  });

  // Example admin API: list products for a shop
  router.get("/products", async (req, res) => {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ success: false, message: "Missing shop param" });

    try {
      const result = await pool.query("SELECT access_token FROM shops WHERE shop_origin = $1", [shop]);
      if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Shop not installed" });

      const accessToken = result.rows[0].access_token;

      const session = { shop, accessToken };
      const RestClient = shopify.clients.Rest;
      const client = new RestClient({ session });
      const productsResp = await client.get({ path: 'products', query: { limit: 10 } });

      return res.json({ success: true, products: productsResp.body.products });
    } catch (err) {
      console.error("List products failed:", err);
      return res.status(500).json({ success: false, message: "Failed to fetch products" });
    }
  });

  // Webhook endpoint with HMAC verification
  router.post(
    "/webhooks",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
      const body = req.body;

      const digest = crypto
        .createHmac("sha256", process.env.SHOPIFY_API_SECRET || "")
        .update(body)
        .digest("base64");

      if (!hmacHeader || digest !== hmacHeader) {
        console.warn("Invalid webhook HMAC");
        return res.status(401).send("Invalid HMAC");
      }

      try {
        const json = JSON.parse(body.toString());
        // TODO: handle webhook topics (orders/create, products/update, etc.)
        console.log("Received webhook:", json);
        return res.status(200).send("OK");
      } catch (err) {
        console.error("Webhook handling error:", err);
        return res.status(500).send("Webhook processing failed");
      }
    }
  );

  app.use("/shopify", router);
};
