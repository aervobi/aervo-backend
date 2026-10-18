// Daily summary email: scheduling, the "send me a test" button, and unsubscribe.
//
//  - runDailySummaries(pool) is called every hour by a cron job in index.js. It
//    emails each opted-in person ONCE per local day, at DAILY_SUMMARY_HOUR (7am by
//    default) in THEIR time zone. If the server was down at 7, it catches up later
//    that morning (up to 10pm) and then skips the day.
//  - A person is "claimed" for the day with an atomic UPDATE before anything is
//    sent, so overlapping runs, restarts or two server instances can't send twice.
//    If the send fails the claim is released so the next hourly run retries.
//  - Every email carries a signed one-click unsubscribe link and the
//    List-Unsubscribe headers mail apps use for their own unsubscribe button.
const express = require("express");
const crypto = require("crypto");
const { JWT_SECRET } = require("../middleware/auth");
const { buildSummary, writeInsight, renderEmail } = require("../utils/dailySummary");
const { isValidTimeZone, localDate, localHour } = require("../utils/tzdate");
const { CHAT_MODEL, replyText } = require("../utils/aiModels");
const { effectivePlan, planFor } = require("../utils/planAccess");
const { withAiContext } = require("../utils/aiSpend");

const SEND_HOUR = () => Number(process.env.DAILY_SUMMARY_HOUR) || 7;
const LAST_HOUR = 22; // don't send "good morning" after 10pm local
const DEFAULT_TZ = () => (isValidTimeZone(process.env.DEFAULT_TIMEZONE) ? process.env.DEFAULT_TIMEZONE : "America/New_York");
const API_BASE = () => process.env.API_PUBLIC_URL || "https://api.aervoapp.com";
const FRONTEND = () => process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
const MAX_ATTEMPTS_PER_DAY = 3;
const attempts = new Map(); // `${userId}:${date}` -> count (in memory is fine: it only limits retries)

// ── unsubscribe tokens: userId.hmac, no expiry (an old email's link keeps working)
const UNSUB_KEY = () => crypto.createHash("sha256").update("aervo-unsub:" + JWT_SECRET).digest();
function unsubToken(userId) {
  const mac = crypto.createHmac("sha256", UNSUB_KEY()).update(String(userId)).digest("hex").slice(0, 32);
  return `${userId}.${mac}`;
}
function userIdFromToken(token) {
  const [id, mac] = String(token || "").split(".");
  if (!/^\d+$/.test(id || "") || !/^[a-f0-9]{32}$/.test(mac || "")) return null;
  const want = unsubToken(id).split(".")[1];
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want)) ? Number(id) : null;
}
const unsubUrl = (userId) => `${API_BASE()}/api/email/unsubscribe?t=${unsubToken(userId)}`;

const isRealEmail = (e) => !!e && !/@shopify\.aervoapp\.com$/i.test(e); // auto-created Shopify accounts have no inbox

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sharedAnthropic;
function anthropicClient() {
  if (sharedAnthropic !== undefined) return sharedAnthropic;
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    sharedAnthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  } catch {
    sharedAnthropic = null;
  }
  return sharedAnthropic;
}

// Build and send one person's summary. Throws if the send fails.
async function sendSummaryTo(pool, row, { now, tz, sender, anthropic, fetchImpl }) {
  const user = { id: row.id, email: row.email, name: row.name, company_name: row.company_name, platform: row.platform };
  const summary = await buildSummary(pool, user, { now, tz, prefs: row, fetchImpl });
  const insight = await writeInsight(summary, { anthropic, model: CHAT_MODEL, replyText });
  const { subject, html, text } = renderEmail({
    user,
    summary,
    insight,
    unsubscribeUrl: unsubUrl(user.id),
    settingsUrl: `${FRONTEND()}/settings`,
  });
  await sender({
    to: user.email,
    subject,
    html,
    text,
    headers: {
      "List-Unsubscribe": `<${unsubUrl(user.id)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  return { subject, sources: summary.sources.length };
}

// The hourly job
async function runDailySummaries(pool, opts = {}) {
  const now = opts.now || new Date();
  const sender = opts.sender || require("../utils/email").sendDailySummaryEmail;
  const anthropic = opts.anthropic !== undefined ? opts.anthropic : anthropicClient();
  const pauseMs = opts.pauseMs !== undefined ? opts.pauseMs : 600; // stay under the email provider's rate limit
  const stats = { checked: 0, sent: 0, skipped: 0, failed: 0 };

  const rows = (
    await pool.query(
      `SELECT u.id, u.email, u.name, u.company_name, u.platform, to_jsonb(u) AS urow,
              np.timezone, np.revenue_alerts, np.inventory_alerts,
              to_char(np.last_daily_sent_on, 'YYYY-MM-DD') AS last_sent
       FROM notification_preferences np
       JOIN users u ON u.id = np.user_id
       WHERE np.daily_summary = TRUE AND u.email_verified = TRUE`
    )
  ).rows;

  for (const row of rows) {
    stats.checked++;
    try {
      // Lite accounts (trial over, no paid plan) don't get the daily email
      if (!isRealEmail(row.email) || effectivePlan(row.urow).plan === "free") {
        stats.skipped++;
        continue;
      }
      const tz = isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_TZ();
      const today = localDate(now, tz);
      const hour = localHour(now, tz);
      if (hour < SEND_HOUR() || hour > LAST_HOUR || row.last_sent === today) {
        stats.skipped++;
        continue;
      }
      const key = `${row.id}:${today}`;
      if ((attempts.get(key) || 0) >= MAX_ATTEMPTS_PER_DAY) {
        stats.skipped++;
        continue;
      }

      // Claim today first. Only one caller can win this UPDATE.
      const claim = await pool.query(
        `UPDATE notification_preferences SET last_daily_sent_on = $2::date
         WHERE user_id = $1 AND daily_summary = TRUE
           AND (last_daily_sent_on IS NULL OR last_daily_sent_on < $2::date)
         RETURNING user_id`,
        [row.id, today]
      );
      if (claim.rowCount === 0) {
        stats.skipped++;
        continue;
      }

      try {
        attempts.set(key, (attempts.get(key) || 0) + 1);
        await withAiContext({ userId: row.id, feature: "daily-summary" }, () =>
          sendSummaryTo(pool, row, { now, tz, sender, anthropic, fetchImpl: opts.fetchImpl })
        );
        stats.sent++;
        if (pauseMs) await sleep(pauseMs);
      } catch (err) {
        // release the claim so the next hourly run tries again
        await pool.query(
          `UPDATE notification_preferences SET last_daily_sent_on = $3::date
           WHERE user_id = $1 AND last_daily_sent_on = $2::date`,
          [row.id, today, row.last_sent || null]
        );
        stats.failed++;
        console.error(`Daily summary failed for user ${row.id}:`, err.message);
      }
    } catch (err) {
      stats.failed++;
      console.error(`Daily summary error for user ${row.id}:`, err.message);
    }
  }
  console.log("Daily summaries:", JSON.stringify(stats));
  return stats;
}

// ── small HTML pages for the unsubscribe flow ────────────────────────────────
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex" /><title>${title}</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#02030a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:420px;margin:24px;padding:32px;border:1px solid #1f2937;border-radius:16px;background:#070b17;text-align:center">${body}</div></body></html>`;

module.exports = function dailySummaryRoutes(pool, authenticateToken) {
  const router = express.Router();

  pool
    .query(
      `ALTER TABLE notification_preferences
         ADD COLUMN IF NOT EXISTS daily_summary BOOLEAN NOT NULL DEFAULT FALSE,
         ADD COLUMN IF NOT EXISTS timezone TEXT,
         ADD COLUMN IF NOT EXISTS last_daily_sent_on DATE`
    )
    .catch((err) => console.error("Daily summary columns:", err.message));

  // ── "Send me a test" (Settings) ──────────────────────────────────────────
  const testLog = new Map(); // userId -> [timestamps]
  router.post("/api/user/daily-summary/test", authenticateToken, async (req, res) => {
    try {
      const id = req.user.userId;
      if ((await planFor(pool, id)).plan === "free") {
        return res.status(403).json({
          success: false,
          code: "PLAN_LIMIT",
          requiredPlan: "essential",
          message: "The daily summary email is included with every paid plan.",
        });
      }
      const recent = (testLog.get(id) || []).filter((t) => Date.now() - t < 3600 * 1000);
      if (recent.length >= 3) {
        return res.status(429).json({ success: false, message: "That's 3 test emails in the last hour. Please try again later." });
      }

      const row = (
        await pool.query(
          `SELECT u.id, u.email, u.name, u.company_name, u.platform,
                  np.timezone, np.revenue_alerts, np.inventory_alerts
           FROM users u LEFT JOIN notification_preferences np ON np.user_id = u.id WHERE u.id = $1`,
          [id]
        )
      ).rows[0];
      if (!row) return res.status(404).json({ success: false, message: "Account not found." });
      if (!isRealEmail(row.email)) {
        return res.status(400).json({ success: false, message: "Add a real email address to your account first." });
      }

      const asked = req.body && req.body.timezone;
      const tz = isValidTimeZone(asked) ? asked : isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_TZ();
      testLog.set(id, [...recent, Date.now()]);
      await sendSummaryTo(pool, row, {
        now: new Date(),
        tz,
        sender: require("../utils/email").sendDailySummaryEmail,
        anthropic: anthropicClient(),
      });
      const [name, domain] = row.email.split("@");
      res.json({ success: true, sentTo: `${name.slice(0, 2)}***@${domain}` });
    } catch (err) {
      console.error("Daily summary test error:", err.message);
      res.status(500).json({ success: false, message: "We couldn't send the test email. Please try again." });
    }
  });

  // ── unsubscribe ──────────────────────────────────────────────────────────
  // GET only shows a confirmation page (mail scanners open links, so a GET must
  // never change anything). POST does it; it's also what a mail app's one-click
  // "Unsubscribe" button sends.
  router.get("/api/email/unsubscribe", (req, res) => {
    const t = String(req.query.t || "");
    if (!userIdFromToken(t)) {
      return res.status(400).send(page("Link not valid", `<h1 style="font-size:20px">This link isn't valid</h1><p style="color:#9ca3af;font-size:14px">You can turn the daily summary off any time in <a style="color:#60a5fa" href="${FRONTEND()}/settings">Settings → Notifications</a>.</p>`));
    }
    res.send(
      page(
        "Unsubscribe",
        `<h1 style="font-size:20px;margin:0 0 8px">Stop the daily summary?</h1>
<p style="color:#9ca3af;font-size:14px;line-height:1.6">You'll no longer get the Aervo daily summary email. You can turn it back on in Settings whenever you like.</p>
<form method="POST" action="/api/email/unsubscribe?t=${encodeURIComponent(t)}" style="margin-top:20px">
<button type="submit" style="padding:12px 24px;border:0;border-radius:999px;background:linear-gradient(90deg,#29c8ff,#7c5cff);color:#050816;font-weight:700;font-size:14px;cursor:pointer">Unsubscribe</button></form>`
      )
    );
  });

  router.post("/api/email/unsubscribe", async (req, res) => {
    const userId = userIdFromToken(req.query.t || (req.body && req.body.t));
    if (!userId) {
      return res.status(400).send(page("Link not valid", `<h1 style="font-size:20px">This link isn't valid</h1>`));
    }
    try {
      await pool.query("UPDATE notification_preferences SET daily_summary = FALSE WHERE user_id = $1", [userId]);
      const wantsHtml = /text\/html/.test(req.headers.accept || "");
      if (!wantsHtml) return res.json({ success: true });
      res.send(
        page(
          "Unsubscribed",
          `<h1 style="font-size:20px;margin:0 0 8px">You're unsubscribed</h1>
<p style="color:#9ca3af;font-size:14px;line-height:1.6">You won't get the daily summary any more. Changed your mind? Turn it back on in <a style="color:#60a5fa" href="${FRONTEND()}/settings">Settings → Notifications</a>.</p>`
        )
      );
    } catch (err) {
      console.error("Unsubscribe error:", err.message);
      res.status(500).send(page("Something went wrong", `<h1 style="font-size:20px">Something went wrong</h1><p style="color:#9ca3af;font-size:14px">Please try again, or turn it off in Settings.</p>`));
    }
  });

  return router;
};

module.exports.runDailySummaries = runDailySummaries;
module.exports.sendSummaryTo = sendSummaryTo;
module.exports.__test = { unsubToken, userIdFromToken, isRealEmail, attempts };
