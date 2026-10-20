// utils/marketBriefing.js
// The Weekly Marketing Brief on the Local Market tab (one per city + business type per week).
//
// One briefing per city + business type per week, shared by every store that
// matches (see routes/market.js for caching and the Monday job). Claude
// researches the area with the web search tool and returns 3-6 items as JSON.
//
// Trust rules, enforced here rather than left to the prompt:
//  - every item must cite at least one URL that the web search actually
//    returned in this request; uncited items and made-up links are dropped
//  - links must be http(s); text fields are length-capped plain text
//  - a refusal or an unparseable answer is an error, never a half briefing
// The model comes from utils/aiModels.js (AERVO_AI_MODEL, or AERVO_BRIEFING_MODEL
// for the brief alone); the SDK hook fits the request to it (search tool version,
// fallbacks), so the request below can stay the same for any model.
const { BRIEFING_MODEL } = require("./aiModels");
const KINDS = ["event", "trend", "news", "economy", "competition", "weather", "other"];
const MAX_ITEMS = 6;
const MAX_CONTINUATIONS = 4; // pause_turn resumes for a long web search turn
const MAX_SEARCHES = Math.max(1, Math.min(10, Number(process.env.AERVO_BRIEFING_MAX_SEARCHES) || 5));

const SYSTEM = `You are Aervo's local marketing analyst. You write the Weekly Marketing Brief for the owner of a small brick-and-mortar business: what is happening in and around their area this coming week that could change their foot traffic or sales, and the marketing move to make about it (a promotion, a social post, a menu or display change, staffing or hours).

Research with web search before writing. Prefer local news outlets, city and county announcements, event calendars, university and military base news, chambers of commerce and reputable national sources for category trends. Only use information you found in this conversation's search results.

Rules:
- Every item must be backed by at least one source URL taken exactly from your search results. If you cannot find a source for something, leave it out.
- Never invent figures, dates, prices or business names. If a number is not in a source, don't state one.
- Public information about businesses, events and the economy only. Nothing about private individuals.
- Write for a busy owner: concrete, specific to their type of business and location, plain language.
- It is fine to return fewer items when there isn't much news; never pad.

When you have finished researching, reply with ONLY a JSON object (no markdown fence, no commentary) in this shape:
{"headline": "one sentence, max 120 characters, the single most useful thing this week",
 "items": [{"kind": "event|trend|news|economy|competition|weather|other",
            "title": "max 80 characters",
            "body": "1-2 sentences, max 280 characters: what is happening and why it matters to this business",
            "action": "one short marketing action for this week, max 90 characters, or empty string",
            "date": "YYYY-MM-DD if it happens on a specific day this week or next, else empty string",
            "sources": ["https://...", "..."]}]}
Return between 3 and ${MAX_ITEMS} items, most useful first.`;

const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
const isHttp = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:";
  } catch {
    return false;
  }
};
// Compare URLs loosely: same host + path (ignore trailing slash, query order, fragments)
const urlKey = (u) => {
  try {
    const x = new URL(u);
    return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return null;
  }
};

// Every URL the web search tool returned, with its title (for source chips)
function searchedSources(content) {
  const out = new Map();
  for (const block of content || []) {
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue; // error results are objects
    for (const r of block.content) {
      if (r && r.type === "web_search_result" && isHttp(r.url)) {
        const k = urlKey(r.url);
        if (k && !out.has(k)) out.set(k, { url: r.url, title: clip(r.title, 120) || new URL(r.url).host });
      }
    }
  }
  return out;
}

// The final answer: text after the last tool result, as one string
function finalText(content) {
  let last = -1;
  (content || []).forEach((b, i) => {
    if (b.type === "web_search_tool_result" || b.type === "server_tool_use") last = i;
  });
  return (content || [])
    .slice(last + 1)
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("");
}

function parseBriefing(text, sources) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Briefing answer had no JSON");
  let raw;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Briefing answer was not valid JSON");
  }
  const items = [];
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    const cited = [];
    for (const u of Array.isArray(it.sources) ? it.sources : []) {
      const hit = sources.get(urlKey(u));
      if (hit && !cited.some((c) => c.url === hit.url)) cited.push(hit);
    }
    if (!cited.length) continue; // no verifiable source: leave it out
    const title = clip(it.title, 80);
    const body = clip(it.body, 280);
    if (!title || !body) continue;
    items.push({
      kind: KINDS.includes(it.kind) ? it.kind : "other",
      title,
      body,
      action: clip(it.action, 90),
      date: /^\d{4}-\d{2}-\d{2}$/.test(it.date || "") ? it.date : "",
      sources: cited.slice(0, 3),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  if (!items.length) throw new Error("Briefing had no items with verifiable sources");
  return { headline: clip(raw.headline, 120) || items[0].title, items };
}

/**
 * @param {object} p
 * @param {import("@anthropic-ai/sdk").default} p.anthropic
 * @param {{city:string, state:string, timezone?:string}} p.area
 * @param {string} p.categoryLabel  e.g. "Coffee shop"
 * @param {string} p.weekStart      YYYY-MM-DD (Monday)
 * @param {string} p.weekEnd        YYYY-MM-DD (Sunday)
 */
async function generateBriefing({ anthropic, area, categoryLabel, weekStart, weekEnd }) {
  if (!anthropic) throw new Error("ANTHROPIC_API_KEY is not set");
  const userLocation = { type: "approximate", city: area.city, region: area.state, country: "US" };
  if (area.timezone) userLocation.timezone = area.timezone;

  const messages = [
    {
      role: "user",
      content:
        `Today's date is ${new Date().toISOString().slice(0, 10)}. Search for current local information; ` +
        `don't rely on what you remember about this area.\n` +
        `Business: ${categoryLabel} in ${area.city}, ${area.state}.\n` +
        `Week: ${weekStart} to ${weekEnd}.\n\n` +
        `Find what matters for this business this week: local events and crowds (sports, concerts, festivals, ` +
        `university or military schedules), local news (road work, openings and closings, city decisions), the local ` +
        `economy and consumer trends in this category. Then write this week's marketing brief.`,
    },
  ];

  const request = {
    model: BRIEFING_MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "medium" },
    // Each search adds result pages Claude reads (the main cost of a briefing)
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES, user_location: userLocation }],
    // If a safety classifier declines, re-run on Anthropic's recommended model
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };

  const content = [];
  let response;
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    response = await anthropic.beta.messages.create({ ...request, messages });
    content.push(...response.content);
    if (response.stop_reason !== "pause_turn") break;
    // A long search turn paused: send it back as-is so Claude continues
    messages.push({ role: "assistant", content: response.content });
  }

  if (response.stop_reason === "refusal") {
    const err = new Error(`Briefing declined (${(response.stop_details && response.stop_details.category) || "refusal"})`);
    err.refusal = true;
    throw err;
  }
  if (response.stop_reason === "pause_turn") throw new Error("Briefing research did not finish");
  if (response.stop_reason === "max_tokens") throw new Error("Briefing answer was cut off");

  const sources = searchedSources(content);
  const briefing = parseBriefing(finalText(response.content), sources);
  return {
    ...briefing,
    model: response.model || BRIEFING_MODEL,
    searched: sources.size,
    usage: response.usage
      ? { input: response.usage.input_tokens, output: response.usage.output_tokens, searches: (response.usage.server_tool_use || {}).web_search_requests || null }
      : null,
  };
}

module.exports = { generateBriefing, parseBriefing, searchedSources, finalText, urlKey, BRIEFING_MODEL, KINDS };
