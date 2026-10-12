// ============================================================
// Aervo QuickBooks Integration — Weekly Narrative Digest
// File: routes/intelligence/digest.js
// See quickbooks-integration-spec.md section 6.
//
// Unlike margin calc (regenerated only by the nightly sync), this
// route generates lazily on request per the spec: return the cached
// digest if one exists for the current week, otherwise generate and
// cache it — never call Claude fresh on every page load.
// ============================================================

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Claude sometimes wraps JSON output in a ```json fence despite being
// told not to — strip it if present rather than trusting compliance.
function parseJsonResponse(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenceMatch ? fenceMatch[1] : trimmed);
}

function summarizeTotals(products) {
  const totalRevenue = products.reduce((sum, p) => sum + p.revenue, 0);
  const totalCost = products.reduce((sum, p) => sum + p.cost, 0);
  const marginPct = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : null;
  return {
    total_revenue: round2(totalRevenue),
    total_cost: round2(totalCost),
    margin_pct: marginPct != null ? round2(marginPct) : null,
    product_count: products.length,
  };
}

function buildPrompt(current, currentTotals, prior, priorTotals) {
  const priorSection = prior
    ? `Prior week (${prior.period_start} to ${prior.period_end}):
- Total revenue: $${priorTotals.total_revenue}
- Total cost: $${priorTotals.total_cost}
- Overall margin: ${priorTotals.margin_pct}%
- Per-product breakdown: ${JSON.stringify(prior.data)}`
    : 'No prior week data available for comparison — this is the first week with margin data.';

  return `You are Aervo, an AI business advisor for small business owners. Write a short weekly financial digest based ONLY on the numbers below — do not invent any facts, products, or figures that aren't present in this data.

This week (${current.period_start} to ${current.period_end}):
- Total revenue: $${currentTotals.total_revenue}
- Total cost: $${currentTotals.total_cost}
- Overall margin: ${currentTotals.margin_pct}%
- Per-product breakdown: ${JSON.stringify(current.data)}

${priorSection}

Note: a product with "estimated": true has a cost that's an approximation (derived from an overall cost ratio, not a real QuickBooks record for that item) — mention this caveat only if it's directly relevant to a point you're making, don't dwell on it.

Return raw JSON only, no markdown, no preamble, in this exact shape:
{
  "headline": "one plain-language sentence summarizing what happened this week",
  "bullets": ["reason one", "reason two", "reason three"]
}

The "bullets" array must have 2 or 3 items. Ground every claim strictly in the numbers above — do not speculate beyond what the data shows.`;
}

module.exports = function (pool, authenticateToken) {
  const router = express.Router();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  async function generateAndCacheDigest(userId, current, prior) {
    const currentTotals = summarizeTotals(current.data);
    const priorTotals = prior ? summarizeTotals(prior.data) : null;
    const prompt = buildPrompt(current, currentTotals, prior, priorTotals);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const parsed = parseJsonResponse(response.content[0].text);
    const body = parsed.bullets.map((b) => `- ${b}`).join('\n');

    await pool.query(
      `INSERT INTO digests (user_id, period_type, period_start, period_end, headline, body, generated_at)
       VALUES ($1, 'week', $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, period_type, period_start) DO UPDATE SET
         period_end   = EXCLUDED.period_end,
         headline     = EXCLUDED.headline,
         body         = EXCLUDED.body,
         generated_at = NOW()`,
      [userId, current.period_start, current.period_end, parsed.headline, body]
    );

    return {
      period_start: current.period_start,
      period_end: current.period_end,
      headline: parsed.headline,
      body,
    };
  }

  // ============================================================
  // GET /api/intelligence/digest?period=week
  // ============================================================
  router.get('/api/intelligence/digest', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    try {
      const marginRows = await pool.query(
        `SELECT period_start::text AS period_start, period_end::text AS period_end, data
         FROM margin_snapshots
         WHERE user_id = $1 AND period_type = 'week'
         ORDER BY period_start DESC
         LIMIT 2`,
        [userId]
      );

      if (!marginRows.rows.length || !marginRows.rows[0].data.length) {
        return res.json({
          success: true,
          generated: false,
          message: 'No margin data yet for this week — the digest is generated once the nightly QuickBooks sync produces a margin snapshot.',
        });
      }

      const current = marginRows.rows[0];
      const prior = marginRows.rows[1] || null;

      const cached = await pool.query(
        `SELECT period_end::text AS period_end, headline, body, generated_at
         FROM digests
         WHERE user_id = $1 AND period_type = 'week' AND period_start = $2`,
        [userId, current.period_start]
      );

      if (cached.rows.length) {
        const row = cached.rows[0];
        return res.json({
          success: true,
          generated: true,
          cached: true,
          period_start: current.period_start,
          period_end: row.period_end,
          headline: row.headline,
          body: row.body,
          generated_at: row.generated_at,
        });
      }

      const digest = await generateAndCacheDigest(userId, current, prior);

      res.json({
        success: true,
        generated: true,
        cached: false,
        ...digest,
      });
    } catch (err) {
      console.error('Error generating intelligence digest', { userId, error: err.message });
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  return router;
};
