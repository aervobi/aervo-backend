// utils/aiSpend.js
// What every Claude call costs, per account per day, so the Founder view can
// show real AI margins instead of estimates.
//
//  - install(pool) hooks the Anthropic SDK once at startup (messages.create and
//    beta.messages.create). It only reads the finished response's usage; the
//    caller gets the exact same promise back, so no feature changes behaviour.
//  - The account comes from the signed-in request (authenticateToken calls
//    enterRequest). Background jobs and shared work (city briefings, the local
//    angle) run inside withAiContext({ userId: 0, feature }) and count as
//    "shared", so one store never pays for work every store in its city uses.
//  - Cost is an estimate from list prices in RATES (per million tokens) plus
//    web searches; update RATES if Anthropic's prices change.
const { AsyncLocalStorage } = require("async_hooks");
const budget = require("./aiBudget");
const { adaptRequest } = require("./aiModels");

const als = new AsyncLocalStorage();

// $ per million tokens [input, output], matched by model-id prefix
const RATES = [
  ["claude-fable-5", 10, 50],
  ["claude-mythos-5", 10, 50],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus", 5, 25],
  ["claude-sonnet-5-5", 2, 10],
  ["claude-sonnet-5", 2, 10],
  ["claude-sonnet-4", 3, 15],
  ["claude-haiku-5-5", 0.1, 0.5],
  ["claude-haiku-4-5", 1, 5],
  ["claude-haiku", 1, 5],
];
const WEB_SEARCH_USD = 10 / 1000; // per search

function rateFor(model) {
  const m = String(model || "");
  const hit = RATES.find(([prefix]) => m.startsWith(prefix));
  return hit ? { input: hit[1], output: hit[2] } : { input: 5, output: 25 }; // unknown: assume Opus-class
}

function costOf(model, usage) {
  if (!usage) return 0;
  let r = rateFor(model);
  // Haiku 5.5 has a second rate card for prompts over 100K tokens
  const prompt = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  if (String(model || "").startsWith("claude-haiku-5-5") && prompt > 100000) r = { input: 0.5, output: 2.5 };
  const M = 1e6;
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  return (
    ((usage.input_tokens || 0) * r.input) / M +
    ((usage.output_tokens || 0) * r.output) / M +
    ((usage.cache_read_input_tokens || 0) * r.input * 0.1) / M +
    ((usage.cache_creation_input_tokens || 0) * r.input * 1.25) / M +
    searches * WEB_SEARCH_USD
  );
}

// Request paths -> a short feature name ("/api/ai/chat" -> "ai/chat")
function featureFromRoute(path) {
  return (
    String(path || "")
      .split("?")[0]
      .replace(/^\/(api|integrations)\//, "")
      .replace(/\/\d+(?=\/|$)/g, "/:id")
      .slice(0, 60) || "other"
  );
}

let pool = null;
let installed = false;
let tableReady = null;

function ensureTable() {
  if (!tableReady) {
    tableReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS ai_spend (
           day           DATE NOT NULL,
           user_id       INTEGER NOT NULL,      -- 0 = shared / background work
           feature       TEXT NOT NULL,
           model         TEXT NOT NULL,
           calls         INTEGER NOT NULL DEFAULT 0,
           input_tokens  BIGINT NOT NULL DEFAULT 0,
           output_tokens BIGINT NOT NULL DEFAULT 0,
           searches      INTEGER NOT NULL DEFAULT 0,
           cost_usd      NUMERIC(14, 6) NOT NULL DEFAULT 0,
           PRIMARY KEY (day, user_id, feature, model)
         )`
      )
      .catch((err) => {
        tableReady = null;
        throw err;
      });
  }
  return tableReady;
}

async function record(model, usage, ctx) {
  if (!pool || !usage) return;
  await ensureTable();
  const userId = ctx && Number.isInteger(ctx.userId) ? ctx.userId : 0;
  const feature = (ctx && ctx.feature) || "background";
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  budget.add(userId, costOf(model, usage)); // keep the guardrail totals current
  await pool.query(
    `INSERT INTO ai_spend (day, user_id, feature, model, calls, input_tokens, output_tokens, searches, cost_usd)
     VALUES (CURRENT_DATE, $1, $2, $3, 1, $4, $5, $6, $7)
     ON CONFLICT (day, user_id, feature, model) DO UPDATE SET
       calls = ai_spend.calls + 1,
       input_tokens = ai_spend.input_tokens + EXCLUDED.input_tokens,
       output_tokens = ai_spend.output_tokens + EXCLUDED.output_tokens,
       searches = ai_spend.searches + EXCLUDED.searches,
       cost_usd = ai_spend.cost_usd + EXCLUDED.cost_usd`,
    [
      userId,
      feature,
      String(model || "unknown"),
      (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      usage.output_tokens || 0,
      searches,
      costOf(model, usage),
    ]
  );
}

function wrap(proto) {
  if (!proto || typeof proto.create !== "function" || proto.create.__aervoSpend) return;
  const original = proto.create;
  const wrapped = function (body, options) {
    // Fit the request to the chosen model (see utils/aiModels.js adaptRequest)
    body = adaptRequest(body);
    const ctx = als.getStore();
    // Guardrails: over budget or paused -> refuse before anything is sent.
    // Every feature catches this and shows its non-AI fallback.
    const allowed = budget.check({ userId: ctx && ctx.userId, feature: ctx && ctx.feature });
    if (!allowed.ok) {
      return Promise.reject(new budget.AiBudgetError(`AI paused (${allowed.reason})`, allowed));
    }
    const result = original.call(this, body, options);
    // Out of credits / bad key / rate limited: pause instead of failing every page
    Promise.resolve(result).catch((err) => budget.noteError(err));
    // Streams report usage differently; only plain requests are counted
    if (body && body.stream) return result;
    Promise.resolve(result)
      .then((res) => record((res && res.model) || (body && body.model), res && res.usage, ctx))
      .catch(() => {}); // the caller handles its own errors; logging never breaks a feature
    return result; // the caller gets the original promise, untouched
  };
  wrapped.__aervoSpend = true;
  proto.create = wrapped;
}

function install(dbPool, opts = {}) {
  pool = dbPool;
  budget.init(dbPool, opts);
  if (installed) return;
  installed = true;
  const sdk = require("@anthropic-ai/sdk");
  const Anthropic = sdk.default || sdk;
  wrap(Anthropic.Messages && Anthropic.Messages.prototype);
  wrap(Anthropic.Beta && Anthropic.Beta.Messages && Anthropic.Beta.Messages.prototype);
}

// Called by authenticateToken: AI calls later in this request belong to this account
function enterRequest(userId, path) {
  als.enterWith({ userId: Number(userId) || 0, feature: featureFromRoute(path) });
}

// Run fn with an explicit account/feature (background jobs, shared work)
function withAiContext(ctx, fn) {
  return als.run({ userId: Number(ctx.userId) || 0, feature: ctx.feature || "background" }, fn);
}

module.exports = { install, enterRequest, withAiContext, costOf, rateFor, featureFromRoute, RATES };
