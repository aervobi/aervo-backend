// utils/aiBudget.js
// Guardrails on what Claude can cost, checked before every call (see the SDK
// hook in utils/aiSpend.js). Customers never see an error page because of it:
// each feature already has a non-AI fallback, and this decides when to use it.
//
// Budgets (env, US dollars, estimated from token use the same way as ai_spend):
//   AI_MONTHLY_BUDGET_USD  (default 40)   whole app, calendar month
//   AI_DAILY_BUDGET_USD    (default 6)    whole app, per UTC day
//   AI_ACCOUNT_DAILY_USD   (default 0.75) one account, per UTC day
//
// Features are tiered so the least important ones stop first:
//   background  Weekly Marketing Brief, competitor themes, local angle ... stops at 70% of the
//               month or 80% of the day (stores see their latest brief / no themes)
//   standard    insights, health score, daily email insight ... stops at 90% / 100%
//               (pages show their built-in insights)
//   chat        Ask Aervo, the thing customers type into: runs until 100% of the month
//
// Circuit breaker: if Anthropic says the credit balance is too low, the key is
// bad, or we're rate limited, all AI pauses for a few minutes instead of
// failing on every page view, and founders get one email about it.
const PERCENT = { background: { month: 0.7, day: 0.8 }, standard: { month: 0.9, day: 1 }, chat: { month: 1, day: 1.5 } };
const REFRESH_MS = 5 * 60 * 1000;

const num = (v, d) => {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? x : d;
};
const limits = () => ({
  month: num(process.env.AI_MONTHLY_BUDGET_USD, 40),
  day: num(process.env.AI_DAILY_BUDGET_USD, 6),
  account: num(process.env.AI_ACCOUNT_DAILY_USD, 0.75),
});

// Which tier a feature (request path or explicit name) belongs to
function tierOf(feature) {
  const f = String(feature || "");
  if (/^(ai\/chat|intelligence\/chat)/.test(f)) return "chat";
  if (/^(market\/|intelligence\/digest|background)/.test(f)) return "background";
  return "standard";
}

class AiBudgetError extends Error {
  constructor(message, { tier, reason } = {}) {
    super(message);
    this.name = "AiBudgetError";
    this.tier = tier;
    this.reason = reason; // budget_month | budget_day | budget_account | paused
  }
}

const state = {
  monthKey: null,
  dayKey: null,
  month: 0, // $ this month
  day: 0, // $ today
  byAccount: new Map(), // userId -> $ today
  loadedAt: 0,
  pausedUntil: 0,
  pauseReason: null,
};
let pool = null;
let notify = null; // async ({ kind, subject, text }) -> void, set by init

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

function rollOver() {
  if (state.monthKey !== thisMonth()) {
    state.monthKey = thisMonth();
    state.month = 0;
  }
  if (state.dayKey !== today()) {
    state.dayKey = today();
    state.day = 0;
    state.byAccount = new Map();
  }
}

// Load the real totals from ai_spend (also catches spend from other server instances)
async function refresh() {
  if (!pool) return;
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(cost_usd) FILTER (WHERE day >= date_trunc('month', CURRENT_DATE)), 0)::float AS month,
              COALESCE(SUM(cost_usd) FILTER (WHERE day = CURRENT_DATE), 0)::float AS day
         FROM ai_spend WHERE day >= date_trunc('month', CURRENT_DATE)`
    );
    const acc = await pool.query(
      `SELECT user_id, SUM(cost_usd)::float AS cost FROM ai_spend WHERE day = CURRENT_DATE AND user_id > 0 GROUP BY user_id`
    );
    rollOver();
    state.month = Math.max(state.month, r.rows[0].month);
    state.day = Math.max(state.day, r.rows[0].day);
    for (const row of acc.rows) state.byAccount.set(row.user_id, Math.max(state.byAccount.get(row.user_id) || 0, row.cost));
    state.loadedAt = Date.now();
  } catch (err) {
    if (err.code !== "42P01") console.warn("AI budget refresh failed:", err.message);
  }
}

function maybeRefresh() {
  if (Date.now() - state.loadedAt > REFRESH_MS) refresh();
}

// Called by aiSpend after each call is priced
function add(userId, cost) {
  rollOver();
  state.month += cost;
  state.day += cost;
  if (userId) state.byAccount.set(userId, (state.byAccount.get(userId) || 0) + cost);
  checkAlerts().catch(() => {});
}

/**
 * Can this call go ahead? Synchronous (in-memory totals), so it never slows a request.
 * @returns {{ ok: true } | { ok: false, reason: string, tier: string }}
 */
function check({ userId, feature, tier }) {
  rollOver();
  maybeRefresh();
  const t = tier || tierOf(feature);
  if (Date.now() < state.pausedUntil) return { ok: false, reason: "paused", tier: t };
  const L = limits();
  const p = PERCENT[t];
  if (L.month > 0 && state.month >= L.month * p.month) return { ok: false, reason: "budget_month", tier: t };
  if (L.day > 0 && state.day >= L.day * p.day) return { ok: false, reason: "budget_day", tier: t };
  // One account can't use more than its share in a day (shared/background work is user 0)
  if (userId && L.account > 0 && t !== "background" && (state.byAccount.get(userId) || 0) >= L.account) {
    return { ok: false, reason: "budget_account", tier: t };
  }
  return { ok: true };
}

function guard(ctx) {
  const c = check(ctx || {});
  if (!c.ok) throw new AiBudgetError(`AI paused (${c.reason})`, c);
}

// Errors from Anthropic that mean "stop calling for a while"
function noteError(err) {
  const status = err && err.status;
  const msg = String((err && err.message) || "");
  let pauseMs = 0;
  let reason = null;
  if (/credit balance is too low/i.test(msg)) {
    pauseMs = 15 * 60 * 1000;
    reason = "Claude API credit balance is too low";
  } else if (status === 401 || status === 403) {
    pauseMs = 15 * 60 * 1000;
    reason = "Claude API key was rejected";
  } else if (status === 429) {
    pauseMs = 60 * 1000;
    reason = "Claude API rate limit";
  } else if (status === 529) {
    pauseMs = 30 * 1000;
    reason = "Claude API is overloaded";
  }
  if (!pauseMs) return;
  state.pausedUntil = Math.max(state.pausedUntil, Date.now() + pauseMs);
  state.pauseReason = reason;
  console.error(`AI paused for ${Math.round(pauseMs / 1000)}s: ${reason}`);
  if (status !== 429 && status !== 529) {
    sendAlertOnce(`pause:${reason}`, 6 * 3600 * 1000, {
      subject: `Aervo: AI paused, ${reason}`,
      text:
        `Aervo stopped calling Claude because: ${reason}.\n\n` +
        `Customers see built-in insights and their latest Weekly Marketing Brief meanwhile; Ask Aervo shows a "short break" message.\n` +
        `Fix: add credits or turn on auto-reload in the Anthropic Console (Billing), or check ANTHROPIC_API_KEY in Render.\n` +
        `Aervo retries automatically every 15 minutes.`,
    });
  }
}

// ── founder alerts ──────────────────────────────────────────────────────────
const sentInMemory = new Map(); // key -> time (for pause alerts)
function sendAlertOnce(key, everyMs, msg) {
  const last = sentInMemory.get(key) || 0;
  if (Date.now() - last < everyMs || !notify) return;
  sentInMemory.set(key, Date.now());
  notify(msg).catch((err) => console.warn("AI budget alert email failed:", err.message));
}

let alertTable = null;
async function checkAlerts() {
  if (!pool || !notify) return;
  const L = limits();
  if (!L.month) return;
  const pct = state.month / L.month;
  for (const level of [0.5, 0.8, 1]) {
    if (pct < level) continue;
    if (!alertTable) {
      alertTable = pool.query(
        `CREATE TABLE IF NOT EXISTS ai_budget_alerts (month TEXT NOT NULL, level TEXT NOT NULL, sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (month, level))`
      );
    }
    await alertTable;
    // Only the first instance to insert sends it
    const r = await pool.query(
      `INSERT INTO ai_budget_alerts (month, level) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING level`,
      [state.monthKey, String(level)]
    );
    if (!r.rows.length) continue;
    const what =
      level >= 1
        ? "Aervo has reached this month's AI budget. Ask Aervo and all other AI features are paused until the 1st (or until you raise AI_MONTHLY_BUDGET_USD in Render)."
        : level >= 0.8
        ? "New Weekly Marketing Briefs and other background AI are paused (they stop at 70%). Insights stop at 90%, Ask Aervo at 100%."
        : "Everything is still running normally.";
    await notify({
      subject: `Aervo AI spend: ${Math.round(level * 100)}% of this month's budget`,
      text: `Estimated Claude spend this month: $${state.month.toFixed(2)} of $${L.month.toFixed(2)}.\n\n${what}\n\nSee the Founder view for the breakdown by feature and account.`,
    });
  }
}

function status() {
  rollOver();
  const L = limits();
  const paused = Date.now() < state.pausedUntil;
  const tiers = {};
  for (const t of Object.keys(PERCENT)) tiers[t] = check({ tier: t }).ok;
  return {
    monthSpend: Math.round(state.month * 100) / 100,
    daySpend: Math.round(state.day * 100) / 100,
    limits: L,
    paused,
    pauseReason: paused ? state.pauseReason : null,
    pausedUntil: paused ? new Date(state.pausedUntil).toISOString() : null,
    running: tiers, // { background, standard, chat }: true = allowed now
  };
}

function init(dbPool, { sendEmail } = {}) {
  pool = dbPool;
  notify = sendEmail || null;
  refresh();
}

// For tests
function _reset() {
  state.monthKey = state.dayKey = null;
  state.month = state.day = 0;
  state.byAccount = new Map();
  state.loadedAt = Date.now();
  state.pausedUntil = 0;
  state.pauseReason = null;
  sentInMemory.clear();
}

module.exports = { init, check, guard, add, noteError, status, tierOf, refresh, AiBudgetError, _reset, PERCENT };
