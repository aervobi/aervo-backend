
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

    console.log("ORDERS URL:", url);

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    console.log("ORDERS STATUS:", resp.status);

    const bodyText = await resp.text();

    if (!resp.ok) {
      console.error("Shopify orders error:", resp.status, bodyText);
      console.log("ORDERS BODY (truncated):", bodyText ? bodyText.slice(0, 300) : "");
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

  // Sales summary for dashboard (read-only)
  router.get("/sales-summary", async (req, res) => {
    const shop = req.query.shop;
    const locationId = req.query.location_id;

    if (!shop) return res.status(400).json({ success: false, message: "Missing shop param" });
// ✅ Prevent stale 304 responses (VERY IMPORTANT)
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

      // Use the 2024-01 Admin API per requirements and limit to last 24 hours
      const apiVersion = "2024-01";
      const createdAtMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const fields = [
        "id",
        "name",
        "total_price",
        "customer",
        "shipping_address",
        "line_items",
        "created_at",
        "fulfillments",
        "cancelled_at",
      ].join(",");

      // fetch up to 250 orders created in the last 24 hours
      const url = `https://${shop}/admin/api/${apiVersion}/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(
        createdAtMin
      )}&fields=${encodeURIComponent(fields)}`;

      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      });

      const bodyText = await resp.text();

      if (!resp.ok) {
        console.error("Shopify sales-summary error:", resp.status, bodyText);
        // Per requirement: return HTTP 200 with empty summary and log the error
        return res.status(200).json({
          orders_count: 0,
          items_sold: 0,
          gross_sales: 0,
          top_product: null,
          orders: [],
        });
      }

      let json;
      try {
        json = JSON.parse(bodyText);
      } catch (parseErr) {
        console.error("Failed to parse Shopify orders response:", parseErr, bodyText.slice(0, 1000));
        return res.status(200).json({
          orders_count: 0,
          items_sold: 0,
          gross_sales: 0,
          top_product: null,
          orders: [],
        });
      }

      const rawOrders = Array.isArray(json.orders) ? json.orders : [];

const filteredOrders = locationId
  ? rawOrders.filter((o) => {
      // If order has fulfillments, match by location
      if (Array.isArray(o.fulfillments) && o.fulfillments.length > 0) {
        return o.fulfillments.some(
          (f) => String(f.location_id) === String(locationId)
        );
      }

      // If NOT fulfilled yet, still count the sale
      return true;
    })
  : rawOrders;

      if (filteredOrders.length === 0) {
        return res.json({ orders_count: 0, items_sold: 0, gross_sales: 0, top_product: null, orders: [] });
      }

      let itemsSold = 0;
      let grossSales = 0;
      const productCounts = Object.create(null);

      const ordersOut = filteredOrders.map((o) => {
        const orderLineItems = Array.isArray(o.line_items) ? o.line_items : [];

        // sum per order
        for (const li of orderLineItems) {
          const qty = Number(li.quantity || 0);
          itemsSold += qty;
          const title = li.title || "";
          productCounts[title] = (productCounts[title] || 0) + qty;
        }

        // total_price sometimes string; parse safely
        const tp = parseFloat(o.total_price || "0") || 0;
        grossSales += tp;

        const customer = o.customer || {};
        const customerName = customer.first_name || customer.last_name ? `${customer.first_name || ""} ${customer.last_name || ""}`.trim() : customer.name || null;

        return {
          id: o.id ? String(o.id) : null,
          name: o.name || null,
          total_price: o.total_price || "0",
          customer: {
            name: customerName || null,
            email: customer.email || null,
          },
          shipping_address: {
            city: o.shipping_address && o.shipping_address.city ? o.shipping_address.city : null,
            province: o.shipping_address && o.shipping_address.province ? o.shipping_address.province : null,
            country: o.shipping_address && o.shipping_address.country ? o.shipping_address.country : null,
          },
          line_items: orderLineItems.map((li) => ({ title: li.title || "", quantity: Number(li.quantity || 0) })),
        };
      });

      // determine top product
      let topProduct = null;
      let topQty = 0;
      for (const title of Object.keys(productCounts)) {
        if (productCounts[title] > topQty) {
          topQty = productCounts[title];
          topProduct = title;
        }
      }

      // ensure numeric types
      const summary = {
        orders_count: ordersOut.length,
        items_sold: itemsSold,
        gross_sales: Number(Number(grossSales).toFixed(2)),
        top_product: topProduct || null,
        orders: ordersOut,
      };

      return res.json(summary);
    } catch (err) {
      console.error("Sales summary failed:", err);
      // On any error, return 200 with empty summary per requirement
      return res.status(200).json({ orders_count: 0, items_sold: 0, gross_sales: 0, top_product: null, orders: [] });
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

// Inventory summary: map inventory_item_id -> product + variant titles for a location
router.get("/inventory-summary", async (req, res) => {
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

    // 1) fetch inventory levels for the location
    const invUrl = `https://${shop}/admin/api/${apiVersion}/inventory_levels.json?location_ids=${encodeURIComponent(
      locationId
    )}&limit=250`;

    const invResp = await fetch(invUrl, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const invBody = await invResp.text();
    if (!invResp.ok) {
      console.error("Shopify inventory_levels error:", invResp.status, invBody);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch inventory levels",
        shopifyStatus: invResp.status,
        shopifyBody: invBody,
      });
    }

    const invJson = JSON.parse(invBody);
    const inventoryLevels = invJson.inventory_levels || [];

    // If no inventory levels, return empty summary
    if (inventoryLevels.length === 0) {
      return res.json({ success: true, location_id: locationId, items: [] });
    }

    // collect unique inventory_item_ids
    const inventoryItemIds = Array.from(
      new Set(inventoryLevels.map((il) => String(il.inventory_item_id)).filter(Boolean))
    );

    // 2) fetch products (with variants) to map inventory_item_id -> product + variant titles + sku
    // Note: we fetch first page (limit=250) which matches existing pattern in this repo
    const prodUrl = `https://${shop}/admin/api/${apiVersion}/products.json?limit=250&fields=id,title,variants`;
    const prodResp = await fetch(prodUrl, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const prodBody = await prodResp.text();
    if (!prodResp.ok) {
      console.error("Shopify products error:", prodResp.status, prodBody);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch products",
        shopifyStatus: prodResp.status,
        shopifyBody: prodBody,
      });
    }

    const prodJson = JSON.parse(prodBody);
    const products = prodJson.products || [];

    // build mapping inventory_item_id -> { product_title, variant_title, sku }
    const mapping = {};
    for (const p of products) {
      const pTitle = p.title || "";
      for (const v of p.variants || []) {
        if (v && v.inventory_item_id) {
          mapping[String(v.inventory_item_id)] = {
            product_title: pTitle,
            variant_title: v.title || "",
            sku: v.sku || null,
          };
        }
      }
    }

    // assemble items: include null titles/skus when missing for debugging
    const items = inventoryLevels.map((il) => {
      const iid = String(il.inventory_item_id);
      const mapped = mapping[iid] || { product_title: null, variant_title: null, sku: null };
      return {
        inventory_item_id: il.inventory_item_id,
        available: il.available,
        product_title: mapped.product_title,
        variant_title: mapped.variant_title,
        sku: mapped.sku,
      };
    });

    return res.json({ success: true, location_id: locationId, items });
  } catch (err) {
    console.error("Inventory summary failed:", err);
    return res.status(500).json({ success: false, message: "Failed to build inventory summary" });
  }
});

// Insights: reuse inventory-summary logic but compute metrics
router.get("/insights", async (req, res) => {
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

    // fetch inventory levels
    const invUrl = `https://${shop}/admin/api/${apiVersion}/inventory_levels.json?location_ids=${encodeURIComponent(
      locationId
    )}&limit=250`;

    const invResp = await fetch(invUrl, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const invBody = await invResp.text();
    if (!invResp.ok) {
      console.error("Shopify inventory_levels error:", invResp.status, invBody);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch inventory levels",
        shopifyStatus: invResp.status,
        shopifyBody: invBody,
      });
    }

    const invJson = JSON.parse(invBody);
    const inventoryLevels = invJson.inventory_levels || [];

    // fetch products to build mapping
    const prodUrl = `https://${shop}/admin/api/${apiVersion}/products.json?limit=250&fields=id,title,variants`;
    const prodResp = await fetch(prodUrl, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const prodBody = await prodResp.text();
    if (!prodResp.ok) {
      console.error("Shopify products error:", prodResp.status, prodBody);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch products",
        shopifyStatus: prodResp.status,
        shopifyBody: prodBody,
      });
    }

    const prodJson = JSON.parse(prodBody);
    const products = prodJson.products || [];

    // build mapping inventory_item_id -> { product_title, variant_title, sku }
    const mapping = {};
    for (const p of products) {
      const pTitle = p.title || null;
      for (const v of p.variants || []) {
        if (v && v.inventory_item_id) {
          mapping[String(v.inventory_item_id)] = {
            product_title: pTitle,
            variant_title: v.title || null,
            sku: v.sku || null,
          };
        }
      }
    }

    // assemble items
    const items = inventoryLevels.map((il) => {
      const iid = String(il.inventory_item_id);
      const mapped = mapping[iid] || { product_title: null, variant_title: null, sku: null };
      const available = il.available == null ? 0 : Number(il.available);
      return {
        inventory_item_id: il.inventory_item_id,
        available,
        product_title: mapped.product_title,
        variant_title: mapped.variant_title,
        sku: mapped.sku,
      };
    });

    // compute metrics
    const thresholds = { low_stock: 10, overstock: 200 };
    const total_items = items.length;
    const total_units = items.reduce((sum, it) => sum + (typeof it.available === "number" ? it.available : Number(it.available || 0)), 0);
    const missing_sku_count = items.filter((it) => !it.sku).length;
    const missing_mapping_count = items.filter((it) => it.product_title == null).length;

    const low_stock = items.filter((it) => it.available > 0 && it.available <= thresholds.low_stock);
    const out_of_stock = items.filter((it) => it.available === 0);
    const overstock = items.filter((it) => it.available >= thresholds.overstock);
    const missing_sku = items.filter((it) => !it.sku);
    const missing_mapping = items.filter((it) => it.product_title == null);

    return res.json({
      success: true,
      location_id: locationId,
      thresholds,
      totals: {
        total_items,
        total_units,
        missing_sku_count,
        missing_mapping_count,
      },
      low_stock,
      out_of_stock,
      overstock,
      missing_sku,
      missing_mapping,
    });
  } catch (err) {
    console.error("Insights failed:", err);
    return res.status(500).json({ success: false, message: "Failed to build insights" });
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
