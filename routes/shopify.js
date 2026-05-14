// backend/routes/shopify.js  (UPDATED)
// Registers Shopify mandatory compliance webhooks + app/uninstalled

const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");

module.exports = function (pool) {
  const router = express.Router();

  const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
  const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
  const SHOPIFY_SCOPES =
    process.env.SHOPIFY_SCOPES ||
    "read_products,read_orders,read_customers,read_inventory";
  const APP_URL = process.env.APP_URL; // must be https://...
  const FRONTEND_URL = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
  const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !APP_URL) {
    console.warn(
      "⚠️ Missing one of SHOPIFY_API_KEY / SHOPIFY_API_SECRET / APP_URL in env."
    );
  }

  function safeCompare(a, b) {
    const aBuf = Buffer.from(String(a), "utf8");
    const bBuf = Buffer.from(String(b), "utf8");
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  }

  function verifyOAuthHmac(query) {
    // Shopify OAuth callback HMAC is sha256 hex of sorted query string (excluding hmac)
    const { hmac, ...rest } = query;

    const message = Object.keys(rest)
      .sort()
      .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(",") : rest[key]}`)
      .join("&");

    const digest = crypto
      .createHmac("sha256", SHOPIFY_API_SECRET)
      .update(message)
      .digest("hex");

    return safeCompare(digest, hmac);
  }

  async function registerWebhook(shop, accessToken, topic, address) {
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

    // Shopify returns 201 on success; 422 if already exists sometimes
    const text = await resp.text();
    if (!resp.ok) {
      // Allow "already taken" style responses without failing install
      // But log them so you can debug
      console.warn(
        `⚠️ Webhook register failed (${topic}) status=${resp.status} body=${text}`
      );
      return { ok: false, status: resp.status, body: text };
    }

    return { ok: true, status: resp.status, body: text };
  }

  async function registerRequiredWebhooks(shop, accessToken) {
    const base = `${APP_URL}/webhooks/shopify`;

    const hooks = [
      {
        topic: "customers/data_request",
        address: `${base}/customers_data_request`,
      },
      {
        topic: "customers/redact",
        address: `${base}/customers_redact`,
      },
      {
        topic: "shop/redact",
        address: `${base}/shop_redact`,
      },
      {
        topic: "app/uninstalled",
        address: `${base}/app_uninstalled`,
      },
    ];

    for (const h of hooks) {
      await registerWebhook(shop, accessToken, h.topic, h.address);
    }
  }

  // =========================
  // Start OAuth / Install
  // =========================
  router.get("/", async (req, res) => {
    try {
      const shop = String(req.query.shop || "").trim().toLowerCase();

      if (!shop || !shop.endsWith(".myshopify.com")) {
        return res.status(400).send("Invalid shop domain.");
      }
      // If shop already installed, skip OAuth and redirect to dashboard
const existingShop = await pool.query(
  "SELECT access_token FROM shops WHERE shop_origin = $1",
  [shop]
);
if (existingShop.rows.length > 0 && existingShop.rows[0].access_token) {
  // Find the user for this shop
  const userResult = await pool.query(
    "SELECT u.* FROM users u JOIN shops s ON s.user_id = u.id WHERE s.shop_origin = $1",
    [shop]
  );
  if (userResult.rows.length > 0) {
    const jwt = require("jsonwebtoken");
    const user = userResult.rows[0];
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
   const isStandaloneExisting = req.query.source === 'standalone';
return res.send(`
  <html>
    <head>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${SHOPIFY_API_KEY}"></script>
    </head>
    <body>
      <script>
        const isStandalone = ${isStandaloneExisting};
        const redirectUrl = '${FRONTEND_URL}/dashboard/shopify?shop=${encodeURIComponent(shop)}&token=${token}&host=${req.query.host || ""}${isStandaloneExisting ? "&standalone=1" : ""}';
        if (isStandalone) {
          window.location.href = redirectUrl;
        } else if (window.top !== window.self) {
          window.top.location.href = redirectUrl;
        } else {
          window.location.href = redirectUrl;
        }
      </script>
      <p>Redirecting to Aervo...</p>
    </body>
  </html>
`);
  }
}

      const state = crypto.randomBytes(16).toString("hex");

      const source = req.query.source || 'shopify';
await pool.query(
  `INSERT INTO shopify_oauth_states (shop_origin, state, created_at, source)
   VALUES ($1, $2, NOW(), $3)`,
  [shop, state, source]
);

      const redirectUri = `${APP_URL}/auth/shopify/callback`;

      const installUrl =
        `https://${shop}/admin/oauth/authorize` +
        `?client_id=${SHOPIFY_API_KEY}` +
        `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${state}`;

      return res.send(`
  <html>
    <head>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${SHOPIFY_API_KEY}"></script>
    </head>
    <body>
      <script>
        if (window.top !== window.self) {
          window.top.location.href = '${installUrl}';
        } else {
          window.location.href = '${installUrl}';
        }
      </script>
      <p>Redirecting to Shopify...</p>
    </body>
  </html>
`);
    } catch (err) {
      console.error("OAuth initiation error:", err);
      return res.status(500).send("OAuth failed to start.");
    }
  });

  // =========================
  // OAuth Callback
  // =========================
  router.get("/callback", async (req, res) => {
    try {
      const shop = String(req.query.shop || "").trim().toLowerCase();
      const code = String(req.query.code || "").trim();
      const state = String(req.query.state || "").trim();
      const hmac = String(req.query.hmac || "").trim();

      if (!shop || !code || !state || !hmac) {
        return res.status(400).send("Missing required OAuth parameters.");
      }

      // Verify HMAC
      const isValidHmac = verifyOAuthHmac(req.query);
      if (!isValidHmac) {
        return res.status(401).send("Invalid HMAC.");
      }

      // Verify state
      const stateResult = await pool.query(
  `SELECT source FROM shopify_oauth_states
   WHERE shop_origin = $1 AND state = $2 AND created_at > NOW() - INTERVAL '10 minutes'`,
  [shop, state]
);

      if (stateResult.rows.length === 0) {
        return res.status(400).send("Invalid or expired OAuth state.");
      }

      // Consume state
      await pool.query(
        `DELETE FROM shopify_oauth_states WHERE shop_origin = $1 AND state = $2`,
        [shop, state]
      );

      // Exchange code for access token
      const tokenResponse = await fetch(
        `https://${shop}/admin/oauth/access_token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: SHOPIFY_API_KEY,
            client_secret: SHOPIFY_API_SECRET,
            code,
          }),
        }
      );

      const tokenText = await tokenResponse.text();
      if (!tokenResponse.ok) {
        console.error("Token exchange failed:", tokenResponse.status, tokenText);
        return res.status(500).send("Failed to exchange OAuth code.");
      }

      const tokenData = JSON.parse(tokenText);
      const { access_token, scope } = tokenData;

      if (!access_token) {
        console.error("Token exchange response missing access_token:", tokenData);
        return res.status(500).send("OAuth token missing.");
      }

      // Save shop once
      await pool.query(
        `INSERT INTO shops (shop_origin, access_token, scope, store_name, installed_at)
         VALUES ($1::text, $2::text, $3::text, $1::text, NOW())
         ON CONFLICT (shop_origin)
         DO UPDATE SET
           access_token = EXCLUDED.access_token,
           scope        = EXCLUDED.scope,
           installed_at = NOW()`,
        [shop, access_token, scope || null]
      );

      // ✅ Register mandatory compliance webhooks + app/uninstalled
      await registerRequiredWebhooks(shop, access_token);

    console.log(`✅ Shop ${shop} connected + webhooks registered`);

// Auto-login: find or create Aervo user for this shop
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const shopEmail = `${shop.replace(".myshopify.com", "")}@shopify.aervoapp.com`;

let user;
const existing = await pool.query("SELECT * FROM users WHERE email = $1", [shopEmail]);

if (existing.rows.length > 0) {
  user = existing.rows[0];
} else {
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, company_name, role, email_verified)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [shopEmail, passwordHash, shop, "Owner", true]
  );
  user = result.rows[0];
}

await pool.query("UPDATE shops SET user_id = $1 WHERE shop_origin = $2", [user.id, shop]);

// Insert into connected_stores
const existingStore = await pool.query(
  `SELECT id FROM connected_stores WHERE user_id = $1 AND store_origin = $2`,
  [user.id, shop]
);
if (existingStore.rows.length > 0) {
  await pool.query(
    `UPDATE connected_stores SET is_active = true, connected_at = NOW() WHERE user_id = $1 AND store_origin = $2`,
    [user.id, shop]
  );
} else {
  await pool.query(
    `INSERT INTO connected_stores (user_id, integration_name, store_id, store_name, store_origin, is_active, connected_at)
     VALUES ($1, 'shopify', $2, $2, $2, true, NOW())`,
    [user.id, shop]
  );
}

const token = jwt.sign(
  { userId: user.id, email: user.email },
  process.env.JWT_SECRET,
  { expiresIn: "7d" }
);

const source = stateResult.rows[0]?.source || 'shopify';
const isStandalone = source === 'standalone';

return res.send(`
  <html>
    <head>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${SHOPIFY_API_KEY}"></script>
    </head>
    <body>
      <script>
        const isStandalone = ${isStandalone};
        const redirectUrl = '${FRONTEND_URL}/dashboard/shopify?connected=1&shop=${encodeURIComponent(shop)}&token=${token}${isStandalone ? "&standalone=1" : ""}';
        if (isStandalone) {
          window.location.href = redirectUrl;
        } else if (window.top !== window.self) {
          window.top.location.href = redirectUrl;
        } else {
          window.location.href = redirectUrl;
        }
      </script>
      <p>Redirecting to Aervo...</p>
    </body>
  </html>
`);
    } catch (err) {
      console.error("OAuth callback error:", err);
      return res.status(500).send("OAuth callback failed.");
    }
  });

  // Session token exchange — App Bridge sends this, we return a JWT
router.post("/session-token", async (req, res) => {
  try {
    const { sessionToken, shop } = req.body;
    if (!sessionToken || !shop) {
      return res.status(400).json({ success: false, message: "Missing sessionToken or shop" });
    }

    // Verify the session token (it's a JWT signed by Shopify)
    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(sessionToken, SHOPIFY_API_SECRET, { algorithms: ["HS256"] });

    if (!decoded || !decoded.dest) {
      return res.status(401).json({ success: false, message: "Invalid session token" });
    }

    // Find user for this shop
    const userResult = await pool.query(
      "SELECT u.* FROM users u JOIN shops s ON s.user_id = u.id WHERE s.shop_origin = $1",
      [shop]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Shop not found" });
    }

    const user = userResult.rows[0];
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({ success: true, token });
  } catch (err) {
    console.error("Session token exchange error:", err);
    return res.status(401).json({ success: false, message: "Invalid session token" });
  }
});
// =========================
// Billing API
// =========================

const BILLING_PLANS = {
  essential: { name: "Aervo Essential", price: "19.00", trialDays: 0 },
  pro:       { name: "Aervo Pro",       price: "49.00", trialDays: 14 },
  business:  { name: "Aervo Business",  price: "99.00", trialDays: 0 },
};

async function getShopAccessToken(shop) {
  const result = await pool.query(
    "SELECT access_token FROM shops WHERE shop_origin = $1",
    [shop]
  );
  return result.rows[0]?.access_token || null;
}

// GET /auth/shopify/billing/plans
router.get("/billing/plans", async (req, res) => {
  return res.json({ success: true, plans: BILLING_PLANS });
});

// GET /auth/shopify/billing/upgrade/:plan
router.get("/billing/upgrade/:plan", async (req, res) => {
  try {
    const planKey = req.params.plan;
    const shop = String(req.query.shop || "").trim().toLowerCase();

    if (!shop || !shop.endsWith(".myshopify.com")) {
      return res.status(400).json({ success: false, message: "Invalid shop" });
    }

    const plan = BILLING_PLANS[planKey];
    if (!plan) {
      return res.status(400).json({ success: false, message: "Invalid plan" });
    }

    const accessToken = await getShopAccessToken(shop);
    if (!accessToken) {
      return res.status(401).json({ success: false, message: "Shop not connected" });
    }

    const returnUrl = `${APP_URL}/auth/shopify/billing/confirm?shop=${encodeURIComponent(shop)}&plan=${planKey}`;

    const graphqlResponse = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `
            mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $test: Boolean!, $lineItems: [AppSubscriptionLineItemInput!]!) {
              appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, lineItems: $lineItems) {
                appSubscription {
                  id
                  status
                }
                confirmationUrl
                userErrors {
                  field
                  message
                }
              }
            }
          `,
          variables: {
            name: plan.name,
            returnUrl: returnUrl,
            test: true,
            lineItems: [
              {
                plan: {
                  appRecurringPricingDetails: {
                    price: {
                      amount: plan.price,
                      currencyCode: "USD"
                    },
                    interval: "EVERY_30_DAYS"
                  }
                }
              }
            ]
          }
        }),
      }
    );

    const responseText = await graphqlResponse.text();
    console.log("GraphQL billing response:", responseText);

    const data = JSON.parse(responseText);

    if (data.errors) {
      console.error("GraphQL errors:", data.errors);
      return res.status(500).json({ success: false, message: "Billing error", detail: data.errors });
    }

    const result = data.data?.appSubscriptionCreate;

    if (result?.userErrors?.length > 0) {
      console.error("User errors:", result.userErrors);
      return res.status(400).json({ success: false, message: result.userErrors[0].message });
    }

    const confirmationUrl = result?.confirmationUrl;
    if (!confirmationUrl) {
      return res.status(500).json({ success: false, message: "No confirmation URL returned" });
    }

    return res.redirect(confirmationUrl);

  } catch (err) {
    console.error("Billing upgrade error:", err);
    return res.status(500).json({ success: false, message: "Billing error" });
  }
});

// GET /auth/shopify/billing/confirm
// Shopify redirects here after merchant approves the charge
router.get("/billing/confirm", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim().toLowerCase();
    const planKey = String(req.query.plan || "").trim();
    const chargeId = String(req.query.charge_id || "").trim();

    if (!shop || !planKey || !chargeId) {
      return res.status(400).send("Missing required parameters.");
    }

    const accessToken = await getShopAccessToken(shop);
    if (!accessToken) {
      return res.status(401).send("Shop not connected.");
    }

    // Activate the charge
    const activateResponse = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/recurring_application_charges/${chargeId}/activate.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recurring_application_charge: { id: chargeId }
        }),
      }
    );

    if (!activateResponse.ok) {
      const errText = await activateResponse.text();
      console.error("Charge activation failed:", errText);
      return res.status(500).send("Failed to activate charge.");
    }

    // Update user plan in database
    await pool.query(
      `UPDATE users SET plan = $1
       WHERE id = (SELECT user_id FROM shops WHERE shop_origin = $2)`,
      [planKey, shop]
    );

    console.log(`✅ Plan updated to ${planKey} for ${shop}`);

    // Redirect back to dashboard
    return res.send(`
      <html>
        <head>
          <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${SHOPIFY_API_KEY}"></script>
        </head>
        <body>
          <script>
            const redirectUrl = '${FRONTEND_URL}/dashboard/shopify?upgraded=1&plan=${planKey}';
            if (window.top !== window.self) {
              window.top.location.href = redirectUrl;
            } else {
              window.location.href = redirectUrl;
            }
          </script>
          <p>Activating your plan...</p>
        </body>
      </html>
    `);

  } catch (err) {
    console.error("Billing confirm error:", err);
    return res.status(500).send("Billing confirmation failed.");
  }
});

  return router;
};