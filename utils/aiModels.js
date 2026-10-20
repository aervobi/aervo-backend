// The Claude model(s) Aervo uses, in one place.
//
// AERVO_AI_MODEL (Render env) picks the model for every feature. Default:
// claude-haiku-5-5, the most affordable model ($0.10 / $0.50 per million tokens
// for prompts up to 100K tokens). A feature can still be pointed elsewhere with
// its own variable: AERVO_CHAT_MODEL, AERVO_INSIGHTS_MODEL, AERVO_BRIEFING_MODEL
// (weekly marketing brief) or AERVO_RADAR_MODEL (competitor review themes).
//
// adaptRequest() (applied to every call by the SDK hook in utils/aiSpend.js)
// adjusts a request to what the chosen model accepts, so changing the model in
// Render never breaks a feature:
//  - effort: set to "low" when a call doesn't choose one (newer models think by
//    default; low keeps chat and insights fast and cheap), removed on models
//    that don't support it (Haiku 4.5)
//  - thinking counts toward max_tokens, so small caps are raised to leave room
//  - temperature / top_p / top_k removed where the model rejects them
//  - server-side refusal fallbacks only where the model supports them
//  - web search / web fetch use the tool version the model supports
//
// Notes from testing the Claude API (2026-10):
//  - claude-sonnet-4-20250514 has been retired (404), so don't reuse it.
//  - Newer models (Haiku 5.5, Sonnet 5.5, Opus 5.5...) may start a reply with
//    "thinking" blocks: always read replies with replyText(), never content[0].
const AI_MODEL = process.env.AERVO_AI_MODEL || "claude-haiku-5-5";

const CHAT_MODEL = process.env.AERVO_CHAT_MODEL || AI_MODEL;
const INSIGHT_MODEL = process.env.AERVO_INSIGHTS_MODEL || AI_MODEL;
const BRIEFING_MODEL = process.env.AERVO_BRIEFING_MODEL || AI_MODEL;
const RADAR_MODEL = process.env.AERVO_RADAR_MODEL || AI_MODEL;

// What a model accepts (prefix match on the model id)
function capabilities(model) {
  const m = String(model || "");
  const is = (re) => re.test(m);
  // Effort levels + adaptive thinking (Opus 4.5+ for effort; Haiku 4.5 rejects it)
  const effort = is(/^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable-5|mythos-5|haiku-5)/);
  // Models that think on their own when `thinking` isn't sent
  const thinksByDefault = is(/^claude-(opus-5|sonnet-5|fable-5|mythos-5|haiku-5)/);
  // Sampling parameters removed / restricted
  const noSampling = is(/^claude-(opus-(4-[7-9]|5)|sonnet-5|fable-5|mythos-5|haiku-5)/);
  // `fallbacks: "default"` (server-side refusal fallback)
  const fallbacks = is(/^claude-(opus-5|sonnet-5-5|fable-5-1|mythos-5-1)/);
  // Dynamic-filtering web tools (web_search_20260209 / web_fetch_20260209)
  const dynamicWebTools = is(/^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5))/);
  return { effort, thinksByDefault, noSampling, fallbacks, dynamicWebTools };
}

const MIN_TOKENS_WHEN_THINKING = 2048;

// Returns a copy of a Messages API request body that the model accepts
function adaptRequest(body) {
  if (!body || typeof body !== "object" || !body.model) return body;
  const c = capabilities(body.model);
  const out = { ...body };

  if (out.output_config) out.output_config = { ...out.output_config };
  if (c.effort) {
    if (!out.output_config) out.output_config = {};
    if (!out.output_config.effort && !out.thinking) out.output_config.effort = "low";
  } else if (out.output_config && out.output_config.effort) {
    delete out.output_config.effort;
    if (!Object.keys(out.output_config).length) delete out.output_config;
  }

  if (c.thinksByDefault && typeof out.max_tokens === "number" && out.max_tokens < MIN_TOKENS_WHEN_THINKING) {
    out.max_tokens = MIN_TOKENS_WHEN_THINKING;
  }

  if (c.noSampling) {
    delete out.temperature;
    delete out.top_p;
    delete out.top_k;
  }

  if (!c.fallbacks && out.fallbacks !== undefined) {
    delete out.fallbacks;
    if (Array.isArray(out.betas)) {
      out.betas = out.betas.filter((b) => !/^server-side-fallback/.test(b));
      if (!out.betas.length) delete out.betas;
    }
  }

  if (!c.dynamicWebTools && Array.isArray(out.tools)) {
    out.tools = out.tools.map((t) =>
      t && t.type === "web_search_20260209"
        ? { ...t, type: "web_search_20250305" }
        : t && t.type === "web_fetch_20260209"
        ? { ...t, type: "web_fetch_20250910" }
        : t
    );
  }
  return out;
}

// A reply's text, whatever blocks the model sent (thinking, text, ...).
function replyText(response) {
  return ((response && response.content) || [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Added to every chat prompt: the UIs show plain text with **bold** and line breaks only.
const PLAIN_TEXT_RULE =
  "Format: plain conversational text. Use **bold** sparingly for key numbers. Never use markdown headings, tables or bullet syntax with # or |; for a list, use short lines starting with a dash.";

module.exports = {
  AI_MODEL,
  CHAT_MODEL,
  INSIGHT_MODEL,
  BRIEFING_MODEL,
  RADAR_MODEL,
  capabilities,
  adaptRequest,
  replyText,
  PLAIN_TEXT_RULE,
};
