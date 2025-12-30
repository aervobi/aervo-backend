
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

module.exports = function (pool) {
  const router = express.Router();

  // Start OAuth install flow: /?shop=storename.myshopify.com (mounted at /auth/shopify)
  router.get("/", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing shop parameter");

  try {
    const state = crypto.randomBytes(16).toString("hex");

    // ✅ Store OAuth state in DB (no cookies)
    await pool.query(
      `
        INSERT INTO shopify_oauth_states (shop_origin, state)
        VALUES ($1, $2)
      `,
      [shop, state]
    );

    const redirectUri = `${buildAppUrl()}/auth/shopify/callback`;
    const scopes = (process.env.SHOPIFY_SCOPES || "read_products").replace(/\s+/g, "");

    const installUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(process.env.SHOPIFY_API_KEY || "")}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;

    console.log("OAuth redirectUri =", redirectUri);
    return res.redirect(installUrl);
  } catch (err) {
  console.error("Shopify callback error:", err);
  return res.status(500).send(`OAuth callback failed: ${err.message}`);
}
});

  // OAuth callback
  router.get("/callback", async (req, res) => {
    try {
      const { shop, hmac, code, state } = req.query;
      if (!shop || !hmac || !code || !state)
  return res.status(400).send("Missing required OAuth parameters");

// ✅ Validate OAuth state from DB (no cookies)
const stateResult = await pool.query(
  `
    SELECT id FROM shopify_oauth_states
    WHERE shop_origin = $1
      AND state = $2
      AND created_at > NOW() - INTERVAL '5 minutes'
    LIMIT 1
  `,
  [shop, state]
);

if (stateResult.rows.length === 0) {
  return res.status(400).send("Invalid OAuth state");
}

// one-time use: clean it up
await pool.query(
  `DELETE FROM shopify_oauth_states WHERE id = $1`,
  [stateResult.rows[0].id]
);

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
 // Example admin API: list products for a shop
router.get("/products", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ success: false, message: "Missing shop param" });

  try {
    const result = await pool.query(
      "SELECT access_token FROM shops WHERE shop_origin = $1",
      [shop]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Shop not installed" });
    }

    const accessToken = result.rows[0].access_token;

    // ✅ Use direct Admin REST call (most reliable)
    const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-10";
    const url = `https://${shop}/admin/api/${apiVersion}/products.json?limit=10`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const bodyText = await resp.text();

    if (!resp.ok) {
      console.error("Shopify products error:", resp.status, bodyText);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch products",
        shopifyStatus: resp.status,
        shopifyBody: bodyText,
      });
    }

    const json = JSON.parse(bodyText);
    return res.json({ success: true, products: json.products || [] });
  } catch (err) {
    console.error("List products failed:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch products" });
  }
});

// Example admin API: list orders for a shop
router.get("/orders", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ success: false, message: "Missing shop param" });

  try {
    const result = await pool.query(
      "SELECT access_token FROM shops WHERE shop_origin = $1",
      [shop]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Shop not installed" });
    }

    const accessToken = result.rows[0].access_token;

    const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-10";
    const fields = "id,name,created_at,processed_at,total_price,subtotal_price,total_tax,total_discounts,currency,financial_status,fulfillment_status,line_items";
    const url = `https://${shop}/admin/api/${apiVersion}/orders.json?status=any&limit=50&fields=${encodeURIComponent(fields)}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const bodyText = await resp.text();

    if (!resp.ok) {
      console.error("Shopify orders error:", resp.status, bodyText);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch orders",
        shopifyStatus: resp.status,
        shopifyBody: bodyText,
      });
    }

    const json = JSON.parse(bodyText);
    return res.json({ success: true, orders: json.orders || [] });
  } catch (err) {
    console.error("List orders failed:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
});

// Example admin API: list locations for a shop
router.get("/locations", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ success: false, message: "Missing shop param" });

  try {
    const result = await pool.query(
      "SELECT access_token FROM shops WHERE shop_origin = $1",
      [shop]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Shop not installed" });
    }

    const accessToken = result.rows[0].access_token;

    const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-10";
    const url = `https://${shop}/admin/api/${apiVersion}/locations.json`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const bodyText = await resp.text();

    if (!resp.ok) {
      console.error("Shopify locations error:", resp.status, bodyText);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch locations",
        shopifyStatus: resp.status,
        shopifyBody: bodyText,
      });
    }

    const json = JSON.parse(bodyText);
    return res.json({ success: true, locations: json.locations || [] });
  } catch (err) {
    console.error("List locations failed:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch locations" });
  }
});

// Example admin API: get inventory levels for a location (required)
router.get("/inventory-levels", async (req, res) => {
  const shop = req.query.shop;
  const locationId = req.query.location_id;

  if (!shop) return res.status(400).json({ success: false, message: "Missing shop param" });
  if (!locationId) return res.status(400).json({ success: false, message: "Missing location_id param" });

  try {
    const result = await pool.query(
      "SELECT access_token FROM shops WHERE shop_origin = $1",
      [shop]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Shop not installed" });
    }

    const accessToken = result.rows[0].access_token;

    const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-10";
    const queryString = `?location_ids=${encodeURIComponent(locationId)}&limit=250`;
    const url = `https://${shop}/admin/api/${apiVersion}/inventory_levels.json${queryString}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const bodyText = await resp.text();

    if (!resp.ok) {
      console.error("Shopify inventory_levels error:", resp.status, bodyText);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch inventory levels",
        shopifyStatus: resp.status,
        shopifyBody: bodyText,
      });
    }

    const json = JSON.parse(bodyText);
    return res.json({ success: true, inventory_levels: json.inventory_levels || [] });
  } catch (err) {
    console.error("List inventory levels failed:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch inventory levels" });
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

  return router;
};
