// utils/planAccess.js
// One place that answers "what does this account's plan allow?" for the server.
// Limits live in config/plans.js; every gate goes through here so they behave
// the same way and fail CLOSED (an error never unlocks a paid feature).
//
//  - planFor(pool, userId)        -> { plan, limits }
//  - requireFeature(pool, name)   -> middleware: 403 PLAN_LIMIT unless limits[name] is truthy
//  - historyStart(limits)         -> Date (oldest data the plan may see) or null (unlimited)
//  - clampFrom(from, limits)      -> the later of a requested start date and the plan's start
//  - aiQuota(pool)                -> middleware: counts Ask Aervo messages per calendar month
//  - planLimitError(...)          -> the standard 403 body the pages understand
const PLANS = require("../config/plans");

const PLAN_ORDER = ["free", "essential", "pro", "business"];
const PLAN_NAMES = { free: "Starter", essential: "Essential", pro: "Pro", business: "Business" };

async function planFor(pool, userId) {
  const r = await pool.query("SELECT COALESCE(plan, 'free') AS plan FROM users WHERE id = $1", [userId]);
  const plan = PLANS[r.rows[0]?.plan] ? r.rows[0].plan : "free";
  return { plan, limits: PLANS[plan] };
}

// Lowest plan whose limit for `feature` is truthy (or above `atLeast` for numbers)
function requiredPlanFor(feature, atLeast) {
  for (const p of PLAN_ORDER) {
    const v = PLANS[p][feature];
    if (atLeast !== undefined ? Number(v) >= atLeast : !!v) return p;
  }
  return "business";
}

function planLimitError({ message, feature, currentPlan, requiredPlan, code = "PLAN_LIMIT", extra }) {
  const req = requiredPlan || (feature ? requiredPlanFor(feature) : "pro");
  return {
    success: false,
    code,
    message: message || `This feature is included with ${PLAN_NAMES[req]} and above.`,
    feature,
    currentPlan,
    requiredPlan: req,
    requiredPlanName: PLAN_NAMES[req],
    upgradeUrl: "/pricing",
    ...(extra || {}),
  };
}

function requireFeature(pool, feature) {
  return async (req, res, next) => {
    try {
      const { plan, limits } = await planFor(pool, req.user.userId);
      if (!limits[feature]) return res.status(403).json(planLimitError({ feature, currentPlan: plan }));
      req.plan = plan;
      req.planLimits = limits;
      next();
    } catch (err) {
      console.error("Plan check failed:", err.message);
      res.status(503).json({ success: false, message: "Couldn't check your plan. Please try again." });
    }
  };
}

function historyStart(limits) {
  const days = limits && limits.dataHistoryDays;
  if (!days || days === Infinity) return null;
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (days - 1)); // "7 days" = today and the 6 days before
  return d;
}

// For routes that take an optional ?from=YYYY-MM-DD: never earlier than the plan allows
function clampFrom(from, limits) {
  const start = historyStart(limits);
  if (!start) return from || null;
  const asked = from ? new Date(from) : null;
  const use = asked && !isNaN(asked) && asked > start ? asked : start;
  return use.toISOString().slice(0, 10);
}

// ── Ask Aervo monthly allowance ─────────────────────────────────────────────
let usageTable;
function ensureUsageTable(pool) {
  if (!usageTable) {
    usageTable = pool
      .query(
        `CREATE TABLE IF NOT EXISTS ai_usage (
           user_id INTEGER NOT NULL,
           period  TEXT NOT NULL,          -- 'YYYY-MM' (UTC)
           count   INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (user_id, period)
         )`
      )
      .catch((err) => {
        usageTable = null;
        throw err;
      });
  }
  return usageTable;
}
const period = () => new Date().toISOString().slice(0, 7);

// Takes one message from the allowance up front (atomically, so parallel
// requests can't overshoot) and gives it back if the AI call then fails.
// Unlimited plans are not counted.
function aiQuota(pool) {
  return async (req, res, next) => {
    try {
      const { plan, limits } = await planFor(pool, req.user.userId);
      const limit = limits.aiMessagesPerMonth;
      if (limit === Infinity || limit == null) return next();
      await ensureUsageTable(pool);
      const p = period();
      const r = await pool.query(
        `INSERT INTO ai_usage (user_id, period, count) VALUES ($1, $2, 1)
         ON CONFLICT (user_id, period) DO UPDATE SET count = ai_usage.count + 1
           WHERE ai_usage.count < $3
         RETURNING count`,
        [req.user.userId, p, limit]
      );
      if (!r.rows.length) {
        return res.status(403).json(
          planLimitError({
            code: "AI_LIMIT",
            feature: "aiMessagesPerMonth",
            currentPlan: plan,
            requiredPlan: "essential",
            message: `You've used all ${limit} Ask Aervo messages for this month. Upgrade to Essential for unlimited questions.`,
            extra: { limit, remaining: 0 },
          })
        );
      }
      const used = r.rows[0].count;
      res.setHeader("X-AI-Remaining", String(Math.max(0, limit - used)));
      res.on("finish", () => {
        if (res.statusCode >= 400) {
          pool
            .query(`UPDATE ai_usage SET count = GREATEST(count - 1, 0) WHERE user_id = $1 AND period = $2`, [req.user.userId, p])
            .catch(() => {});
        }
      });
      next();
    } catch (err) {
      console.error("AI allowance check failed:", err.message);
      res.status(503).json({ success: false, message: "Couldn't check your plan. Please try again." });
    }
  };
}

async function aiUsage(pool, userId) {
  const { plan, limits } = await planFor(pool, userId);
  const limit = limits.aiMessagesPerMonth;
  if (limit === Infinity || limit == null) return { plan, limit: null, used: null, remaining: null };
  await ensureUsageTable(pool);
  const r = await pool.query(`SELECT count FROM ai_usage WHERE user_id = $1 AND period = $2`, [userId, period()]);
  const used = r.rows[0]?.count || 0;
  return { plan, limit, used, remaining: Math.max(0, limit - used) };
}

// ── Connected sales sources (Shopify / Square) ─────────────────────────────
// `integrations` in config/plans.js counts sales sources: Starter and Essential
// get one (Shopify OR Square), Pro both. Extra Shopify stores count toward
// `maxLocations`. Reconnecting a source you already have is always allowed.
// QuickBooks is accounting, not a sales source, and isn't counted.
// Returns null when allowed, or the 403 body to send.
async function checkSourceLimit(pool, userId, adding, { shop } = {}) {
  const { plan, limits } = await planFor(pool, userId);
  const safe = async (sql) => {
    try {
      return (await pool.query(sql, [userId])).rows;
    } catch (err) {
      if (err.code === "42P01") return []; // table not created yet
      throw err;
    }
  };
  const shopifyStores = await safe(
    `SELECT DISTINCT store_origin FROM connected_stores WHERE user_id = $1 AND integration_name ILIKE 'shopify%'`
  );
  const hasSquare = (await safe(`SELECT 1 FROM square_connections WHERE aervo_merchant_id = $1::text`)).length > 0;
  const sources = new Set();
  if (shopifyStores.length) sources.add("shopify");
  if (hasSquare) sources.add("square");

  if (adding === "shopify" && shopifyStores.length) {
    const already = shop && shopifyStores.some((r) => String(r.store_origin || "").toLowerCase() === String(shop).toLowerCase());
    if (already || shopifyStores.length < (limits.maxLocations || 1)) return null;
    return planLimitError({
      feature: "maxLocations",
      currentPlan: plan,
      requiredPlan: requiredPlanFor("maxLocations", shopifyStores.length + 1),
      message: `Your ${PLAN_NAMES[plan]} plan includes ${limits.maxLocations} store${limits.maxLocations === 1 ? "" : "s"}. Upgrade to connect another.`,
    });
  }
  if (sources.has(adding)) return null;
  if (sources.size < (limits.integrations || 1)) return null;
  return planLimitError({
    feature: "integrations",
    currentPlan: plan,
    requiredPlan: requiredPlanFor("integrations", sources.size + 1),
    message: `Your ${PLAN_NAMES[plan]} plan includes ${limits.integrations} sales source. Upgrade to Pro to connect both Shopify and Square.`,
  });
}

module.exports = {
  checkSourceLimit,
  PLAN_NAMES,
  planFor,
  requiredPlanFor,
  planLimitError,
  requireFeature,
  historyStart,
  clampFrom,
  aiQuota,
  aiUsage,
};
