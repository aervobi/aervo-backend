const express = require("express");
const crypto = require("crypto");

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
  return crypto.timingSafeEqual(
    Buffer.from(hmac, "hex"),
    Buffer.from(query.hmac, "hex")
  );
}

module.exports = function (pool) {
  const router = express.Router();

  // Start OAuth install flow: /?shop=storename.myshopify.com (mounted at /auth/shopify)
  router.get("/", async (req, res) => {
    const shop = req.query.shop;
    if (!shop) return res.status(400).send("Missing shop parameter");

    try {
      const state = crypto.randomBytes(16).toString("hex");

      // Store OAuth state in DB (no cookies)
      await pool.query(
        `
        INSERT INTO shopify_oauth_states (shop_origin, state)
        VALUES ($1, $2)
      `,
        [shop, state]
      );

      const redirectUri = `${buildAppUrl()}/auth/shopify/callback`;
      const scopes = (process.env.SHOPIFY_SCOPES || "read_products,read_orders").replace(
        /\s+/g,
        ""
      );

      const installUrl =
        `https://${shop}/admin/oauth/authorize` +
        `?client_id=${encodeURIComponent(process.env.SHOPIFY_API_KEY || "")}` +
        `&scope=${encodeURIComponent(scopes)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${state}`;

      console.log("OAuth redirectUri =", redirectUri);
      return res.redirect(installUrl);
    } catch (err) {
      console.error("OAuth start error:", err);
      return res.status(500).send(`OAuth start failed: ${err.message}`);
    }
  });

  // OAuth callback
  router.get("/callback", async (req, res) => {
    try {
      const { shop, hmac, code, state } = req.query;
      if (!shop || !hmac || !code || !state) {
        return res.status(400).send("Missing required OAuth parameters");
      }

      // Validate OAuth state from DB (no cookies)
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
      await pool.query(`DELETE FROM shopify_oauth_states WHERE id = $1`, [
        stateResult.rows[0].id,
      ]);

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

      const frontendUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
return res.redirect(`${frontendUrl}/dashboard.html?shop=${encodeURIComponent(shop)}&connected=1`);
    } catch (err) {
      console.error("Shopify callback error:", err);
      return res.status(500).send(`OAuth callback failed: ${err.message}`);
    }
  });

  // PRODUCTS (REST is fine)
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

      const apiVersion = "2024-01";
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

  // ORDERS (GraphQL to avoid protected REST block)
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

      const daysBack = Number(req.query.days_back || 30);
      const createdAtMin = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

      const graphqlUrl = `https://${shop}/admin/api/2024-01/graphql.json`;

      const query = `
        query Orders($q: String!) {
          orders(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                createdAt
                displayFinancialStatus
                displayFulfillmentStatus
                totalPriceSet { shopMoney { amount } }
                lineItems(first: 50) {
                  edges { node { title quantity } }
                }
              }
            }
          }
        }
      `;

      const variables = { q: `created_at:>=${createdAtMin}` };

      console.log("[orders] shop =", shop);
      console.log("[orders] createdAtMin =", createdAtMin);

      const resp = await fetch(graphqlUrl, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      const bodyText = await resp.text();
      console.log("[orders] shopify status =", resp.status);
      console.log("[orders] shopify body (first 500) =", bodyText.slice(0, 500));

      if (!resp.ok) {
        return res.status(500).json({
          success: false,
          message: "Failed to fetch orders (GraphQL)",
          shopifyStatus: resp.status,
          shopifyBody: bodyText,
        });
      }

      const parsed = JSON.parse(bodyText);

      if (parsed.errors && parsed.errors.length) {
        return res.status(500).json({
          success: false,
          message: "GraphQL returned errors",
          shopifyErrors: parsed.errors,
        });
      }

      const orders =
        parsed?.data?.orders?.edges?.map((e) => {
          const n = e.node;
          return {
            id: n.id,
            name: n.name,
            created_at: n.createdAt,
            financial_status: n.displayFinancialStatus || null,
            fulfillment_status: n.displayFulfillmentStatus || null,
            total_price: n.totalPriceSet?.shopMoney?.amount || "0",
            line_items: (n.lineItems?.edges || []).map((li) => ({
              title: li.node?.title || "",
              quantity: Number(li.node?.quantity || 0),
            })),
          };
        }) || [];

      return res.json({ success: true, orders });
    } catch (err) {
      console.error("List orders failed:", err);
      return res.status(500).json({ success: false, message: "Failed to fetch orders" });
    }
  });

  // SALES SUMMARY (GraphQL)
  router.get("/sales-summary", async (req, res) => {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ success: false, message: "Missing shop param" });

    res.set("X-Aervo-Debug", "sales-summary-v2-graphql");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    try {
      const result = await pool.query(
        "SELECT access_token FROM shops WHERE shop_origin = $1",
        [shop]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Shop not installed" });
      }

      const accessToken = result.rows[0].access_token;

      const daysBack = Number(req.query.days_back || 30);
      const createdAtMin = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

      const graphqlUrl = `https://${shop}/admin/api/2024-01/graphql.json`;

      const query = `
        query Orders($q: String!) {
          orders(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                createdAt
                displayFinancialStatus
                displayFulfillmentStatus
                totalPriceSet { shopMoney { amount } }
                lineItems(first: 50) {
                  edges { node { title quantity } }
                }
              }
            }
          }
        }
      `;

      const variables = { q: `created_at:>=${createdAtMin}` };

      console.log("[sales-summary] shop =", shop);
      console.log("[sales-summary] createdAtMin =", createdAtMin);

      const resp = await fetch(graphqlUrl, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      const bodyText = await resp.text();
      console.log("[sales-summary] shopify status =", resp.status);
      console.log("[sales-summary] shopify body (first 500) =", bodyText.slice(0, 500));

      // keep your “always 200” behavior on errors
      if (!resp.ok) {
        return res.status(200).json({
          orders_count: 0,
          items_sold: 0,
          gross_sales: 0,
          top_product: null,
          orders: [],
        });
      }

      const parsed = JSON.parse(bodyText);

      if (parsed.errors && parsed.errors.length) {
        console.error("[sales-summary] graphql errors:", parsed.errors);
        return res.status(200).json({
          orders_count: 0,
          items_sold: 0,
          gross_sales: 0,
          top_product: null,
          orders: [],
        });
      }

      const orders =
        parsed?.data?.orders?.edges?.map((e) => {
          const n = e.node;
          return {
            id: n.id,
            name: n.name,
            created_at: n.createdAt,
            financial_status: n.displayFinancialStatus || null,
            fulfillment_status: n.displayFulfillmentStatus || null,
            total_price: n.totalPriceSet?.shopMoney?.amount || "0",
            line_items: (n.lineItems?.edges || []).map((li) => ({
              title: li.node?.title || "",
              quantity: Number(li.node?.quantity || 0),
            })),
          };
        }) || [];

      if (orders.length === 0) {
        return res.json({
          orders_count: 0,
          items_sold: 0,
          gross_sales: 0,
          top_product: null,
          orders: [],
        });
      }

      let itemsSold = 0;
      let grossSales = 0;
      const productCounts = Object.create(null);

      for (const o of orders) {
        for (const li of o.line_items) {
          const qty = Number(li.quantity || 0);
          itemsSold += qty;
          const title = li.title || "";
          productCounts[title] = (productCounts[title] || 0) + qty;
        }
        grossSales += parseFloat(o.total_price || "0") || 0;
      }

      let topProduct = null;
      let topQty = 0;
      for (const title of Object.keys(productCounts)) {
        if (productCounts[title] > topQty) {
          topQty = productCounts[title];
          topProduct = title;
        }
      }

      return res.json({
        orders_count: orders.length,
        items_sold: itemsSold,
        gross_sales: Number(grossSales.toFixed(2)),
        top_product: topProduct,
        orders,
      });
    } catch (err) {
      console.error("Sales summary failed:", err);
      return res.status(200).json({
        orders_count: 0,
        items_sold: 0,
        gross_sales: 0,
        top_product: null,
        orders: [],
      });
    }
  });

  // LOCATIONS (REST)
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

  // INVENTORY LEVELS (REST)
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

  // inventory-summary + insights + webhooks: leave as-is in your file OR paste your existing blocks below
  // (I didn’t change those blocks in this replacement.)

  // Webhook endpoint with HMAC verification
  router.post("/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
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
      console.log("Received webhook:", json);
      return res.status(200).send("OK");
    } catch (err) {
      console.error("Webhook handling error:", err);
      return res.status(500).send("Webhook processing failed");
    }
  });

  return router;
};