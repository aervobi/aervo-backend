// Founder tools, for the people who build Aervo:
//  - switch their OWN account between plans for free, to try each tier
//  - a read-only view across every customer (GET /api/founder/overview and
//    /api/founder/customers), shown on the /founder page
//
//  - Founders are listed by email in FOUNDER_EMAILS (comma separated). The check
//    uses the signed-in account's email from the database (never the request) and
//    requires that email to be verified.
//  - Only the caller's own plan can change. There is no way to change anyone else's.
//  - A later Stripe or Shopify billing event for the account still wins, as usual.
const express = require("express");
const PLANS = require("../config/plans");

const DEFAULT_FOUNDERS = "omardavila20@gmail.com";

function founderEmails() {
  return (process.env.FOUNDER_EMAILS || DEFAULT_FOUNDERS)
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// row: { email, email_verified }
function isFounder(row) {
  return !!(row && row.email_verified && founderEmails().includes(String(row.email || "").toLowerCase()));
}

module.exports = function founderRoutes(pool, authenticateToken) {
  const router = express.Router();

  // ── POST /api/founder/plan { plan } ── switch your own plan (founders only)
  router.post("/api/founder/plan", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const plan = String(req.body?.plan || "");
      if (!Object.prototype.hasOwnProperty.call(PLANS, plan)) {
        return res.status(400).json({ success: false, message: "Unknown plan." });
      }
      const r = await pool.query("SELECT email, email_verified FROM users WHERE id = $1", [userId]);
      if (!isFounder(r.rows[0])) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      await pool.query("UPDATE users SET plan = $2 WHERE id = $1", [userId, plan]);
      console.log(`Founder plan switch: user ${userId} -> ${plan}`);
      return res.json({ success: true, plan });
    } catch (err) {
      console.error("Founder plan switch error:", err);
      return res.status(500).json({ success: false, message: "Couldn't switch plan." });
    }
  });

  // Every founder data route: signed in AND on the founder list (checked against
  // the database on each request, so removing someone takes effect at once)
  async function requireFounder(req, res, next) {
    try {
      const r = await pool.query("SELECT email, email_verified FROM users WHERE id = $1", [req.user.userId]);
      if (!isFounder(r.rows[0])) return res.status(403).json({ success: false, message: "Access denied" });
      next();
    } catch (err) {
      console.error("Founder check error:", err);
      res.status(500).json({ success: false, message: "Something went wrong." });
    }
  }

  // Optional tables (created by other features on first use) may not exist yet:
  // a failed query gives the fallback instead of breaking the whole page.
  async function safe(sql, params, fallback) {
    try {
      return (await pool.query(sql, params || [])).rows;
    } catch (err) {
      if (err.code !== "42P01" && err.code !== "42703") console.error("Founder query failed:", err.message);
      return fallback;
    }
  }
  const num = (rows, key = "n") => Number((rows && rows[0] && rows[0][key]) || 0);

  // ── GET /api/founder/overview ── business-wide numbers
  router.get("/api/founder/overview", authenticateToken, requireFounder, async (req, res) => {
    try {
      const [totals, plans, platforms, signups, shopify, square, squareErrors, quickbooks, reviews, teams, twofa] = await Promise.all([
        safe(
          `SELECT COUNT(*) AS users,
                  COUNT(*) FILTER (WHERE email_verified) AS verified,
                  COUNT(*) FILTER (WHERE onboarded) AS onboarded,
                  COUNT(*) FILTER (WHERE created_at > NOW() - interval '7 days') AS new7,
                  COUNT(*) FILTER (WHERE created_at > NOW() - interval '30 days') AS new30,
                  COUNT(*) FILTER (WHERE last_login > NOW() - interval '7 days') AS active7,
                  COUNT(*) FILTER (WHERE last_login > NOW() - interval '30 days') AS active30
             FROM users`,
          [],
          [{}]
        ),
        safe(`SELECT COALESCE(plan, 'free') AS key, COUNT(*) AS n FROM users GROUP BY 1`, [], []),
        safe(`SELECT COALESCE(NULLIF(platform, ''), 'none') AS key, COUNT(*) AS n FROM users GROUP BY 1`, [], []),
        safe(
          `SELECT to_char(d, 'YYYY-MM-DD') AS day, COUNT(u.id) AS n
             FROM generate_series(date_trunc('day', NOW()) - interval '29 days', date_trunc('day', NOW()), interval '1 day') d
             LEFT JOIN users u ON date_trunc('day', u.created_at) = d
            GROUP BY d ORDER BY d`,
          [],
          []
        ),
        safe(`SELECT COUNT(DISTINCT user_id) AS n FROM connected_stores WHERE integration_name ILIKE 'shopify%'`, [], []),
        safe(`SELECT COUNT(*) AS n FROM square_connections`, [], []),
        safe(`SELECT COUNT(*) AS n FROM square_connections WHERE sync_error IS NOT NULL AND sync_error <> ''`, [], []),
        safe(`SELECT COUNT(DISTINCT user_id) AS n FROM quickbooks_connections`, [], []),
        safe(`SELECT COUNT(*) AS n FROM google_review_connections`, [], []),
        safe(`SELECT COUNT(*) AS teams, (SELECT COUNT(*) FROM team_members) AS members FROM teams`, [], [{}]),
        safe(`SELECT COUNT(*) AS n FROM users WHERE totp_enabled`, [], []),
      ]);

      const t = totals[0] || {};
      const toMap = (rows) => Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        users: {
          total: Number(t.users || 0),
          verified: Number(t.verified || 0),
          onboarded: Number(t.onboarded || 0),
          new7: Number(t.new7 || 0),
          new30: Number(t.new30 || 0),
          active7: Number(t.active7 || 0),
          active30: Number(t.active30 || 0),
          twoFactor: num(twofa),
        },
        plans: toMap(plans),
        platforms: toMap(platforms),
        signupsByDay: signups.map((r) => ({ day: r.day, count: Number(r.n) })),
        connections: {
          shopify: num(shopify),
          square: num(square),
          squareSyncErrors: num(squareErrors),
          quickbooks: num(quickbooks),
          googleReviews: num(reviews),
        },
        teams: { teams: num(teams, "teams"), members: num(teams, "members") },
      });
    } catch (err) {
      console.error("Founder overview error:", err);
      return res.status(500).json({ success: false, message: "Couldn't load the overview." });
    }
  });

  // ── GET /api/founder/customers?q=&plan=&platform=&sort=&limit=&offset= ── every account
  const SORTS = {
    newest: "u.created_at DESC NULLS LAST",
    oldest: "u.created_at ASC NULLS LAST",
    active: "u.last_login DESC NULLS LAST",
    email: "lower(u.email) ASC",
  };
  router.get("/api/founder/customers", authenticateToken, requireFounder, async (req, res) => {
    try {
      const q = String(req.query.q || "").trim().slice(0, 100);
      const plan = String(req.query.plan || "");
      const platform = String(req.query.platform || "");
      const sort = SORTS[req.query.sort] ? req.query.sort : "newest";
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const where = [];
      const params = [];
      if (q) {
        params.push(`%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
        where.push(`(u.email ILIKE $${params.length} OR u.company_name ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
      }
      if (plan) {
        params.push(plan);
        where.push(`COALESCE(u.plan, 'free') = $${params.length}`);
      }
      if (platform) {
        params.push(platform === "none" ? "" : platform);
        where.push(`COALESCE(u.platform, '') = $${params.length}`);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const count = await pool.query(`SELECT COUNT(*) AS n FROM users u ${whereSql}`, params);
      const page = await pool.query(
        `SELECT u.id, u.email, u.name, u.company_name, COALESCE(u.plan, 'free') AS plan, u.platform,
                u.business_type, u.location, u.email_verified, u.onboarded, u.created_at, u.last_login,
                (u.google_id IS NOT NULL) AS google
           FROM users u ${whereSql}
          ORDER BY ${SORTS[sort]}, u.id DESC
          LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      const ids = page.rows.map((r) => r.id);
      const idText = ids.map(String);

      // Connections for just this page of accounts (optional tables may be missing)
      const [shops, squares, qbs, reviews, teams, twofa] = await Promise.all([
        safe(
          `SELECT DISTINCT ON (user_id) user_id, store_name, store_origin FROM connected_stores
            WHERE user_id = ANY($1::int[]) ORDER BY user_id, is_active DESC, connected_at DESC`,
          [ids],
          []
        ),
        safe(
          `SELECT aervo_merchant_id, sync_status, sync_error, updated_at FROM square_connections WHERE aervo_merchant_id = ANY($1::text[])`,
          [idText],
          []
        ),
        safe(`SELECT DISTINCT user_id FROM quickbooks_connections WHERE user_id = ANY($1::int[])`, [ids], []),
        safe(`SELECT user_id, place_name FROM google_review_connections WHERE user_id = ANY($1::int[])`, [ids], []),
        safe(
          `SELECT tm.user_id, tm.role, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ANY($1::int[])`,
          [ids],
          []
        ),
        safe(`SELECT id FROM users WHERE totp_enabled AND id = ANY($1::int[])`, [ids], []),
      ]);
      const by = (rows, key) => new Map(rows.map((r) => [String(r[key]), r]));
      const shopBy = by(shops, "user_id");
      const squareBy = by(squares, "aervo_merchant_id");
      const qbBy = by(qbs, "user_id");
      const reviewBy = by(reviews, "user_id");
      const teamBy = by(teams, "user_id");
      const twofaBy = by(twofa, "id");

      return res.json({
        success: true,
        total: Number(count.rows[0].n),
        limit,
        offset,
        customers: page.rows.map((u) => {
          const id = String(u.id);
          const shop = shopBy.get(id);
          const sq = squareBy.get(id);
          const team = teamBy.get(id);
          return {
            id: u.id,
            email: u.email,
            name: u.name || "",
            company: u.company_name || "",
            plan: u.plan,
            platform: u.platform || "",
            businessType: u.business_type || "",
            location: u.location || "",
            emailVerified: !!u.email_verified,
            onboarded: !!u.onboarded,
            google: !!u.google,
            twoFactor: twofaBy.has(id),
            createdAt: u.created_at,
            lastLogin: u.last_login,
            isFounder: isFounder({ email: u.email, email_verified: u.email_verified }),
            connections: {
              shopify: shop ? { store: shop.store_name || shop.store_origin } : null,
              square: sq ? { status: sq.sync_status || null, error: sq.sync_error || null } : null,
              quickbooks: qbBy.has(id),
              googleReviews: reviewBy.has(id) ? { place: reviewBy.get(id).place_name || "" } : null,
            },
            team: team ? { name: team.name, role: team.role } : null,
          };
        }),
      });
    } catch (err) {
      console.error("Founder customers error:", err);
      return res.status(500).json({ success: false, message: "Couldn't load customers." });
    }
  });

  return router;
};

module.exports.isFounder = isFounder;
