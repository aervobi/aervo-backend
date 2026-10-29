// backend/routes/shopify.js  (UPDATED)
// Registers Shopify mandatory compliance webhooks + app/uninstalled

const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");
const {
  authenticateToken,
  signSession,
  startSession,
  startChallenge,
} = require("../middleware/auth");
const { requiresSecondFactor } = require("./twoFactor");
const { checkSourceLimit, planFor } = require("../utils/planAccess");
const { getValidShopifyToken, shopifyFetch, tokenColumns } = require("../utils/shopifyToken");

module.exports = function (pool, opts = {}) {
  const router = express.Router();
  const authLimiter = opts.authLimiter || ((req, res, next) => next());

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

  // ── helpers for the auth flow ───────────────────────────────────────────────
  const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
  const SAFE_HOST_RE = /^[A-Za-z0-9_=.-]*$/;

  // JSON that is safe to drop inside an inline <script> (no </script> breakout)
  const scriptJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

  // Shopify signs app-launch URLs the same way as OAuth callbacks; also require
  // a fresh timestamp so an old captured URL can't be replayed later.
  function verifyLaunch(query) {
    if (!query.hmac || !query.timestamp || !verifyOAuthHmac(query)) return false;
    const age = Math.abs(Date.now() / 1000 - Number(query.timestamp));
    return Number.isFinite(age) && age < 3600;
  }

  function dashboardUrl({ shop, host, code, connected, standalone }) {
    const q = new URLSearchParams({ shop });
    if (host && SAFE_HOST_RE.test(host)) q.set("host", host);
    if (code) q.set("code", code);
    if (connected) q.set("connected", "1");
    if (standalone) q.set("standalone", "1");
    return `${FRONTEND_URL}/dashboard/shopify?${q}`;
  }

  // Page that navigates the browser (breaking out of the Shopify admin iframe
  // unless this is a standalone flow). Standalone flows must NOT load App Bridge:
  // on a top-level page it redirects the browser into the Shopify admin.
  function redirectPage(res, url, standalone) {
    const appBridge = standalone
      ? ""
      : `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${SHOPIFY_API_KEY}"></script>`;
    return res.send(`<html>
  <head>
    ${appBridge}
  </head>
  <body>
    <script>
      const url = ${scriptJson(url)};
      if (${standalone ? "true" : "false"}) {
        window.location.href = url;
      } else if (window.top !== window.self) {
        window.top.location.href = url;
      } else {
        window.location.href = url;
      }
    </script>
    <p>Redirecting...</p>
  </body>
</html>`);
  }

  // One-time login codes replace putting a session token in the redirect URL.
  // A code lives 2 minutes, works once, and is stored only as a hash.
  pool
    .query(
      `CREATE TABLE IF NOT EXISTS auth_login_codes (
         code_hash TEXT PRIMARY KEY,
         user_id INTEGER NOT NULL,
         expires_at TIMESTAMPTZ NOT NULL
       )`
    )
    .catch((err) => console.error("auth_login_codes table:", err.message));

  async function issueLoginCode(userId) {
    const code = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(code).digest("hex");
    await pool.query("DELETE FROM auth_login_codes WHERE expires_at < NOW()");
    await pool.query(
      `INSERT INTO auth_login_codes (code_hash, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '2 minutes')`,
      [hash, userId]
    );
    return code;
  }

  function authorizeUrl(shop, state) {
    return (
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${SHOPIFY_API_KEY}` +
      `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(`${APP_URL}/auth/shopify/callback`)}` +
      `&state=${state}`
    );
  }

  // =========================
  // Start OAuth / Install (public: embedded installs, "Continue with Shopify")
  // =========================
  router.get("/", async (req, res) => {
    try {
      const shop = String(req.query.shop || "").trim().toLowerCase();
      if (!SHOP_RE.test(shop)) {
        return res.status(400).send("Invalid shop domain.");
      }
      const source = req.query.source === "standalone" ? "standalone" : "shopify";

      // Relaunching an already-installed app from the Shopify admin. Shopify
      // signs these URLs, so a valid signature proves it came from Shopify for
      // this shop. Anything unsigned goes through the full OAuth consent instead.
      if (verifyLaunch(req.query)) {
        const owner = await pool.query(
          `SELECT u.id FROM users u JOIN shops s ON s.user_id = u.id
           WHERE s.shop_origin = $1 AND s.access_token IS NOT NULL`,
          [shop]
        );
        if (owner.rows.length > 0) {
          const code = await issueLoginCode(owner.rows[0].id);
          return redirectPage(
            res,
            dashboardUrl({ shop, host: req.query.host, code, standalone: source === "standalone" }),
            source === "standalone"
          );
        }
      }

      const state = crypto.randomBytes(16).toString("hex");
      await pool.query(
        `INSERT INTO shopify_oauth_states (shop_origin, state, created_at, source)
         VALUES ($1, $2, NOW(), $3)`,
        [shop, state, source]
      );
      return redirectPage(res, authorizeUrl(shop, state), source === "standalone");
    } catch (err) {
      console.error("OAuth initiation error:", err);
      return res.status(500).send("OAuth failed to start.");
    }
  });

  // =========================
  // Connect a store to the logged-in account (authenticated)
  // A plain link can't carry the login, so the frontend calls this with a
  // fetch and navigates to the returned Shopify URL. The state is tied to the
  // caller, so the callback links the store to THIS account.
  // =========================
  router.post("/connect", authenticateToken, async (req, res) => {
    try {
      const shop = String((req.body && req.body.shop) || "").trim().toLowerCase();
      if (!SHOP_RE.test(shop)) {
        return res.status(400).json({ success: false, message: "Enter a valid .myshopify.com store domain." });
      }
      // Plan limits: number of sales sources and of Shopify stores
      const blocked = await checkSourceLimit(pool, req.user.userId, "shopify", { shop });
      if (blocked) return res.status(403).json(blocked);
      const state = crypto.randomBytes(16).toString("hex");
      await pool.query(
        `INSERT INTO shopify_oauth_states (shop_origin, state, created_at, source, user_id)
         VALUES ($1, $2, NOW(), 'standalone', $3)`,
        [shop, state, req.user.userId]
      );
      return res.json({ success: true, url: authorizeUrl(shop, state) });
    } catch (err) {
      console.error("Shopify connect error:", err);
      return res.status(500).json({ success: false, message: "Could not start the Shopify connection." });
    }
  });

  // =========================
  // Exchange a one-time login code for a session
  // =========================
  router.post("/exchange", authLimiter, async (req, res) => {
    try {
      const code = String((req.body && req.body.code) || "");
      if (!/^[a-f0-9]{64}$/.test(code)) {
        return res.status(400).json({ success: false, message: "Invalid code" });
      }
      const hash = crypto.createHash("sha256").update(code).digest("hex");

      // Atomic single use: the DELETE only succeeds for the first caller
      const used = await pool.query(
        `DELETE FROM auth_login_codes WHERE code_hash = $1 AND expires_at > NOW() RETURNING user_id`,
        [hash]
      );
      if (used.rows.length === 0) {
        return res.status(401).json({ success: false, message: "Code expired. Please try again." });
      }

      const u = await pool.query(
        `SELECT id, email, company_name, platform, token_version FROM users WHERE id = $1`,
        [used.rows[0].user_id]
      );
      if (u.rows.length === 0) return res.status(401).json({ success: false, message: "Account not found" });

      const user = u.rows[0];
      // An account with two-step verification still has to pass it
      if (await requiresSecondFactor(pool, user.id)) {
        startChallenge(res, user);
        return res.json({ success: true, twoFactorRequired: true });
      }
      startSession(res, user);
      return res.json({
        success: true,
        user: { id: user.id, email: user.email, companyName: user.company_name, platform: user.platform },
      });
    } catch (err) {
      console.error("Login code exchange error:", err);
      return res.status(500).json({ success: false, message: "Sign-in failed" });
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

      if (!shop || !code || !state || !hmac || !SHOP_RE.test(shop)) {
        return res.status(400).send("Missing required OAuth parameters.");
      }

      // Verify HMAC
      if (!verifyOAuthHmac(req.query)) {
        return res.status(401).send("Invalid HMAC.");
      }

      // Verify state (also tells us whether a logged-in account started this)
      const stateResult = await pool.query(
        `SELECT source, user_id FROM shopify_oauth_states
         WHERE shop_origin = $1 AND state = $2 AND created_at > NOW() - INTERVAL '10 minutes'`,
        [shop, state]
      );
      if (stateResult.rows.length === 0) {
        return res.status(400).send("Invalid or expired OAuth state.");
      }
      const { source, user_id: initiatingUserId } = stateResult.rows[0];
      const isStandalone = source === "standalone";

      // Consume state
      await pool.query(
        `DELETE FROM shopify_oauth_states WHERE shop_origin = $1 AND state = $2`,
        [shop, state]
      );

      // Exchange code for an expiring offline token (60 min) + refresh token (~90 days)
      const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          client_id: SHOPIFY_API_KEY,
          client_secret: SHOPIFY_API_SECRET,
          code,
          expiring: "1",
        }).toString(),
      });

      const tokenText = await tokenResponse.text();
      if (!tokenResponse.ok) {
        console.error("Token exchange failed:", tokenResponse.status);
        return res.status(500).send("Failed to exchange OAuth code.");
      }

      const tokenData = JSON.parse(tokenText);
      const { access_token, scope } = tokenData;
      if (!access_token) {
        console.error("Token exchange response missing access_token");
        return res.status(500).send("OAuth token missing.");
      }
      if (!tokenData.refresh_token) {
        console.warn(`Token exchange for ${shop} returned no refresh_token (non-expiring token)`);
      }

      // Save shop once (user_id is set below, never by this upsert).
      // Tokens are stored encrypted; see utils/shopifyToken.js.
      const t = tokenColumns(tokenData);
      await pool.query(
        `INSERT INTO shops (shop_origin, access_token, scope, store_name, installed_at,
                            shopify_refresh_token, shopify_token_expires_at,
                            shopify_refresh_token_expires_at, shopify_needs_reconnect)
         VALUES ($1::text, $2::text, $3::text, $1::text, NOW(), $4, $5, $6, false)
         ON CONFLICT (shop_origin)
         DO UPDATE SET
           access_token                     = EXCLUDED.access_token,
           scope                            = EXCLUDED.scope,
           installed_at                     = NOW(),
           shopify_refresh_token            = EXCLUDED.shopify_refresh_token,
           shopify_token_expires_at         = EXCLUDED.shopify_token_expires_at,
           shopify_refresh_token_expires_at = EXCLUDED.shopify_refresh_token_expires_at,
           shopify_needs_reconnect          = false`,
        [shop, t.accessToken, scope || null, t.refreshToken, t.expiresAt, t.refreshExpiresAt]
      );

      // Mandatory compliance webhooks + app/uninstalled
      await registerRequiredWebhooks(shop, access_token);
      console.log(`Shop ${shop} connected + webhooks registered`);

      // Decide which Aervo account this store belongs to
      const bcrypt = require("bcryptjs");
      const currentOwner = (
        await pool.query("SELECT user_id FROM shops WHERE shop_origin = $1", [shop])
      ).rows[0]?.user_id;

      let user;
      if (initiatingUserId) {
        // A logged-in account started this: the store joins that account
        user = (await pool.query("SELECT * FROM users WHERE id = $1", [initiatingUserId])).rows[0];
        if (!user) return res.status(400).send("Account not found.");
      } else if (currentOwner) {
        // Already linked: keep the existing owner rather than re-assigning it
        user = (await pool.query("SELECT * FROM users WHERE id = $1", [currentOwner])).rows[0];
      }
      if (!user) {
        const shopEmail = `${shop.replace(".myshopify.com", "")}@shopify.aervoapp.com`;
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
      }

      await pool.query("UPDATE shops SET user_id = $1 WHERE shop_origin = $2", [user.id, shop]);

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

      // Hand the browser back to the dashboard. Someone already logged in keeps
      // their session; an install-only flow gets a one-time code to sign in with.
      const loginCode = initiatingUserId ? null : await issueLoginCode(user.id);
      return redirectPage(
        res,
        dashboardUrl({ shop, code: loginCode, connected: true, standalone: isStandalone }),
        isStandalone
      );
    } catch (err) {
      console.error("OAuth callback error:", err);
      return res.status(500).send("OAuth callback failed.");
    }
  });

  // =========================
  // Session token exchange (embedded app): App Bridge sends Shopify's signed
  // session token, we return an Aervo session for the store's account.
  // =========================
  router.post("/session-token", async (req, res) => {
    try {
      const { sessionToken } = req.body || {};
      const shop = String((req.body && req.body.shop) || "").trim().toLowerCase();
      if (!sessionToken || !SHOP_RE.test(shop)) {
        return res.status(400).json({ success: false, message: "Missing sessionToken or shop" });
      }

      const jwt = require("jsonwebtoken");
      const decoded = jwt.verify(sessionToken, SHOPIFY_API_SECRET, { algorithms: ["HS256"] });

      // The token must be for THIS app and for THIS shop. Without these checks a
      // valid token from any other store (e.g. an attacker's own) could be used
      // to sign in as the shop named in the request.
      const destHost = (() => {
        try { return new URL(decoded.dest).hostname.toLowerCase(); } catch { return null; }
      })();
      if (decoded.aud !== SHOPIFY_API_KEY || destHost !== shop) {
        return res.status(401).json({ success: false, message: "Invalid session token" });
      }

      const userResult = await pool.query(
        `SELECT u.id, u.email, u.token_version FROM users u
         JOIN shops s ON s.user_id = u.id WHERE s.shop_origin = $1`,
        [shop]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Shop not found" });
      }

      // Third-party cookies are blocked inside the Shopify admin iframe, so this
      // one flow returns a Bearer token. It's short-lived and re-issued by App
      // Bridge on every load.
      const token = signSession(userResult.rows[0], { expiresIn: "12h" });
      return res.json({ success: true, token });
    } catch (err) {
      console.error("Session token exchange error:", err.message);
      return res.status(401).json({ success: false, message: "Invalid session token" });
    }
  });

  // =========================
  // Billing API
  // =========================
  // Monthly prices from October 2026. legacyPrices are what earlier merchants
  // subscribed at; they keep them ("founding member" pricing) and are still
  // recognised when their subscription is checked.
  const BILLING_PLANS = {
    essential: { name: "Aervo Essential", price: "29.00", legacyPrices: ["19.00"] },
    pro:       { name: "Aervo Pro",       price: "69.00", legacyPrices: ["49.00"] },
    business:  { name: "Aervo Business",  price: "149.00", legacyPrices: ["99.00"] },
  };
  // Charges are created in Shopify "test" mode (merchants aren't billed) until
  // SHOPIFY_BILLING_TEST=false is set in the environment.
  const BILLING_TEST = process.env.SHOPIFY_BILLING_TEST !== "false";

  async function getShopAccessToken(shop) {
    try {
      return await getValidShopifyToken(pool, shop, { fetchImpl: fetch });
    } catch (err) {
      if (err.code === "SHOPIFY_NOT_CONNECTED" || err.code === "SHOPIFY_RECONNECT_REQUIRED") return null;
      throw err;
    }
  }

  async function shopGraphql(shop, accessToken, query, variables) {
    const r = await shopifyFetch(pool, shop, `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }, fetch);
    return r.json();
  }

  router.get("/billing/plans", async (req, res) => {
    return res.json({ success: true, plans: BILLING_PLANS });
  });

  // POST /auth/shopify/billing/upgrade/:plan  { shop }  (authenticated)
  // Only the account that owns the store can start a charge for it.
  router.post("/billing/upgrade/:plan", authenticateToken, async (req, res) => {
    try {
      const plan = Object.prototype.hasOwnProperty.call(BILLING_PLANS, req.params.plan)
        ? BILLING_PLANS[req.params.plan]
        : null;
      const planKey = req.params.plan;
      const shop = String((req.body && req.body.shop) || "").trim().toLowerCase();

      if (!SHOP_RE.test(shop)) return res.status(400).json({ success: false, message: "Invalid shop" });
      if (!plan) return res.status(400).json({ success: false, message: "Invalid plan" });

      const owned = await pool.query(
        `SELECT access_token FROM shops WHERE shop_origin = $1 AND user_id = $2`,
        [shop, req.user.userId]
      );
      if (owned.rows.length === 0 || !owned.rows[0].access_token) {
        return res.status(403).json({ success: false, message: "Shop not connected to this account" });
      }
      const accessToken = await getShopAccessToken(shop);
      if (!accessToken) {
        return res.status(409).json({ success: false, message: "Reconnect Shopify in Integrations to continue" });
      }
      // Choosing Pro during the in-app trial keeps the days that are left
      const { trial } = await planFor(pool, req.user.userId);
      const trialDays = planKey === "pro" && trial ? trial.daysLeft : 0;

      const data = await shopGraphql(
        shop,
        accessToken,
        `mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $test: Boolean!, $trialDays: Int, $lineItems: [AppSubscriptionLineItemInput!]!) {
           appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, trialDays: $trialDays, lineItems: $lineItems) {
             appSubscription { id status }
             confirmationUrl
             userErrors { field message }
           }
         }`,
        {
          name: plan.name,
          returnUrl: `${APP_URL}/auth/shopify/billing/confirm?shop=${encodeURIComponent(shop)}`,
          test: BILLING_TEST,
          trialDays,
          lineItems: [
            {
              plan: {
                appRecurringPricingDetails: {
                  price: { amount: plan.price, currencyCode: "USD" },
                  interval: "EVERY_30_DAYS",
                },
              },
            },
          ],
        }
      );

      if (data.errors) {
        console.error("GraphQL billing errors:", JSON.stringify(data.errors));
        return res.status(500).json({ success: false, message: "Billing error" });
      }
      const result = data.data?.appSubscriptionCreate;
      if (result?.userErrors?.length > 0) {
        return res.status(400).json({ success: false, message: result.userErrors[0].message });
      }
      if (!result?.confirmationUrl) {
        return res.status(500).json({ success: false, message: "No confirmation URL returned" });
      }
      return res.json({ success: true, url: result.confirmationUrl, plan: planKey });
    } catch (err) {
      console.error("Billing upgrade error:", err);
      return res.status(500).json({ success: false, message: "Billing error" });
    }
  });

  // GET /auth/shopify/billing/confirm
  // Shopify sends the merchant's browser here after they approve a charge. The
  // plan is decided ONLY from what Shopify says the shop is subscribed to now;
  // nothing in this URL (plan, charge id) is trusted.
  router.get("/billing/confirm", async (req, res) => {
    try {
      const shop = String(req.query.shop || "").trim().toLowerCase();
      if (!SHOP_RE.test(shop)) return res.status(400).send("Invalid shop.");

      const accessToken = await getShopAccessToken(shop);
      if (!accessToken) return res.status(401).send("Shop not connected.");

      const data = await shopGraphql(
        shop,
        accessToken,
        `{ currentAppInstallation { activeSubscriptions {
             name status
             lineItems { plan { pricingDetails { __typename ... on AppRecurringPricing { price { amount } } } } }
           } } }`
      );
      const subs = data.data?.currentAppInstallation?.activeSubscriptions || [];

      // Match by name AND price; if several are active, the most expensive wins
      let planKey = null;
      for (const [key, plan] of Object.entries(BILLING_PLANS)) {
        const match = subs.some(
          (sub) =>
            sub.status === "ACTIVE" &&
            sub.name === plan.name &&
            sub.lineItems.some((li) =>
              [plan.price, ...(plan.legacyPrices || [])].some(
                (p) => Number(li.plan?.pricingDetails?.price?.amount) === Number(p)
              )
            )
        );
        if (match) planKey = key;
      }

      if (planKey) {
        await pool.query(
          `UPDATE users SET plan = $1 WHERE id = (SELECT user_id FROM shops WHERE shop_origin = $2)`,
          [planKey, shop]
        );
        console.log(`Plan updated to ${planKey} for ${shop}`);
      } else {
        console.warn(`Billing confirm for ${shop}: no matching active subscription`);
      }

      const url = `${FRONTEND_URL}/dashboard/shopify?${planKey ? `upgraded=1&plan=${planKey}` : "upgraded=0"}`;
      return redirectPage(res, url, false);
    } catch (err) {
      console.error("Billing confirm error:", err);
      return res.status(500).send("Billing confirmation failed.");
    }
  });

  return router;
};
