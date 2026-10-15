// The Claude models the assistants use, in one place. Override either one from
// the environment (Render) without a code change if a model is ever retired.
//
// Notes from testing the Claude API (2026-10):
//  - claude-sonnet-4-20250514 has been retired (404), so don't reuse it.
//  - claude-sonnet-5-5 thinks before answering by default and writes markdown
//    tables; that eats the token budget and the chat boxes can't render tables.
//    Haiku 4.5 gives short plain answers and is what the other features use.
module.exports = {
  CHAT_MODEL: process.env.AERVO_CHAT_MODEL || "claude-haiku-4-5-20251001",
  INSIGHT_MODEL: process.env.AERVO_INSIGHTS_MODEL || "claude-haiku-4-5-20251001",
};

// A reply's text, whatever blocks the model sent (thinking, text, ...).
module.exports.replyText = function replyText(response) {
  return ((response && response.content) || [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
};

// Added to every chat prompt: the UIs show plain text with **bold** and line breaks only.
module.exports.PLAIN_TEXT_RULE =
  "Format: plain conversational text. Use **bold** sparingly for key numbers. Never use markdown headings, tables or bullet syntax with # or |; for a list, use short lines starting with a dash.";
