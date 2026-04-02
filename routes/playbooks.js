// ============================================================
// Aervo Smart Playbooks — Backend Routes
// File: routes/playbooks.js
// ============================================================

const express   = require('express');
const Anthropic = require('@anthropic-ai/sdk');

module.exports = function (pool, authenticateToken) {
  const router   = express.Router();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// TRIGGER DEFINITIONS
// Priority: higher number = more urgent (sorted desc in UI)
// ============================================================

const TRIGGERS = {
  stockout_imminent:      { priority: 100, title: 'Prevent stockout' },
  revenue_down:           { priority: 80,  title: 'Revenue recovery' },
  vip_customers_quiet:    { priority: 60,  title: 'Re-engage VIP customers' },
  repeat_rate_dropping:   { priority: 50,  title: 'Win back repeat buyers' },
  conversion_falling:     { priority: 40,  title: 'Fix conversion drop' },
  revenue_spike:          { priority: 30,  title: 'Capitalize on revenue spike' },
};

// ============================================================
// DETECTION LOGIC
// Accepts the same store data your dashboard already fetches.
// Returns array of triggered condition objects.
// ============================================================

function detectTriggers(storeData) {
  const triggered = [];
  const {
    revenue7d, revenuePrev7d,
    lowStockProducts,
    repeatRateCurrent, repeatRatePrev,
    vipCustomersQuiet,
    conversionCurrent, conversionPrev,
  } = storeData;

  // 1. Revenue down >10% week over week
  if (revenue7d != null && revenuePrev7d != null && revenuePrev7d > 0) {
    const changePct = ((revenue7d - revenuePrev7d) / revenuePrev7d) * 100;
    if (changePct <= -10) {
      triggered.push({
        trigger_type: 'revenue_down',
        context: {
          revenue7d,
          revenuePrev7d,
          change_pct: Math.round(changePct * 10) / 10,
        },
      });
    }
    // 6. Revenue spike >20% week over week
    if (changePct >= 20) {
      triggered.push({
        trigger_type: 'revenue_spike',
        context: {
          revenue7d,
          revenuePrev7d,
          change_pct: Math.round(changePct * 10) / 10,
        },
      });
    }
  }

  // 2. Stockout imminent — any product with <=5 units
  if (lowStockProducts && lowStockProducts.length > 0) {
    triggered.push({
      trigger_type: 'stockout_imminent',
      context: {
        product_count: lowStockProducts.length,
        products: lowStockProducts.slice(0, 5), // top 5 most urgent
      },
    });
  }

  // 3. Repeat purchase rate dropped >5 points
  if (repeatRateCurrent != null && repeatRatePrev != null) {
    const drop = repeatRatePrev - repeatRateCurrent;
    if (drop >= 5) {
      triggered.push({
        trigger_type: 'repeat_rate_dropping',
        context: {
          current_rate: repeatRateCurrent,
          prev_rate: repeatRatePrev,
          drop_points: Math.round(drop * 10) / 10,
        },
      });
    }
  }

  // 4. VIP customers gone quiet (passed in from customer analytics)
  if (vipCustomersQuiet && vipCustomersQuiet.length > 0) {
    triggered.push({
      trigger_type: 'vip_customers_quiet',
      context: {
        customer_count: vipCustomersQuiet.length,
        avg_ltv: vipCustomersQuiet.reduce((s, c) => s + (c.ltv || 0), 0) / vipCustomersQuiet.length,
      },
    });
  }

  // 5. Conversion rate falling >15% relative
  if (conversionCurrent != null && conversionPrev != null && conversionPrev > 0) {
    const drop = ((conversionCurrent - conversionPrev) / conversionPrev) * 100;
    if (drop <= -15) {
      triggered.push({
        trigger_type: 'conversion_falling',
        context: {
          current_rate: conversionCurrent,
          prev_rate: conversionPrev,
          change_pct: Math.round(drop * 10) / 10,
        },
      });
    }
  }

  return triggered;
}

// ============================================================
// CLAUDE STEP GENERATION
// Generates 5 specific, actionable steps for a given trigger.
// Called once per playbook — result is cached in playbook_steps.
// ============================================================

async function generatePlaybookSteps(triggerType, context, integration) {
  const contextDescriptions = {
    revenue_down: `Revenue is down ${Math.abs(context.change_pct)}% this week vs last week. Current 7-day revenue: $${context.revenue7d?.toLocaleString()}, previous: $${context.revenuePrev7d?.toLocaleString()}.`,
    stockout_imminent: `${context.product_count} product(s) have 5 or fewer units remaining: ${context.products?.map(p => p.title || p.name).join(', ')}.`,
    repeat_rate_dropping: `Repeat purchase rate dropped ${context.drop_points} percentage points (from ${context.prev_rate}% to ${context.current_rate}%).`,
    vip_customers_quiet: `${context.customer_count} high-value customers (avg LTV $${Math.round(context.avg_ltv)}) haven't ordered in 30+ days.`,
    conversion_falling: `Conversion rate dropped ${Math.abs(context.change_pct)}% (from ${context.prev_rate}% to ${context.current_rate}%).`,
    revenue_spike: `Revenue is up ${context.change_pct}% this week vs last week. Current 7-day revenue: $${context.revenue7d?.toLocaleString()}.`,
  };

  const prompt = `You are Aervo, an AI business advisor for ecommerce merchants using ${integration}.

A trigger has been detected in the merchant's store:
${contextDescriptions[triggerType]}

Generate exactly 5 actionable playbook steps to help the merchant respond to this situation. Each step must be specific, practical, and directly address the trigger.

Return a JSON array of exactly 5 objects. No preamble, no markdown, only raw JSON.

Each object must have:
- "step_number": integer 1-5
- "title": short action title (max 8 words)
- "description": 2-3 sentences explaining what to do and why. Be specific to the trigger data above.
- "context_tip": 1-2 sentences of insight drawn directly from the trigger data (e.g. a specific number, product name, or pattern). This will appear in a "from your store data" callout. If no specific data is available for this step, return null.

Example format:
[
  {
    "step_number": 1,
    "title": "Identify the source of the drop",
    "description": "Pull your sales breakdown by product and channel for the last 14 days to pinpoint exactly where revenue fell. Look for a single product category or traffic source that accounts for the majority of the decline.",
    "context_tip": "Your revenue dropped $${Math.abs((context.revenue7d || 0) - (context.revenuePrev7d || 0)).toLocaleString()} this week — isolating where it came from is the fastest path to a fix."
  }
]`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].text.trim();
  const steps = JSON.parse(raw);
  return steps;
}

// ============================================================
// ROUTES
// ============================================================

// GET /api/playbooks
// Returns all playbooks for the authed user, with steps.
// Runs detection on their latest store data and creates new
// playbooks for any triggers not already active in the DB.
// ============================================================

router.get('/api/playbooks', authenticateToken, async (req, res) => {
  const userId      = req.user.id;
  const integration = req.query.integration || 'shopify';

  try {
    // --- 1. Fetch store data for detection ---
    let storeData = {};
    try {
      storeData = await fetchStoreDataForDetection(userId, integration, pool);
    } catch (e) {
      console.error('Store data fetch failed, skipping detection:', e.message);
    }

    // --- 2. Run trigger detection ---
    const triggered = detectTriggers(storeData);

    // --- 3. For each triggered condition, create a playbook if one
    //        isn't already active for this user + trigger_type ---
    for (const { trigger_type, context } of triggered) {
      const existing = await pool.query(
        `SELECT id FROM playbooks
         WHERE user_id = $1 AND trigger_type = $2 AND status = 'active' AND integration = $3`,
        [userId, trigger_type, integration]
      );

      if (existing.rows.length === 0) {
        const meta = TRIGGERS[trigger_type];

        // Insert playbook
        const pb = await pool.query(
          `INSERT INTO playbooks (user_id, trigger_type, title, priority, context_snapshot, integration)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [userId, trigger_type, meta.title, meta.priority, JSON.stringify(context), integration]
        );
        const playbookId = pb.rows[0].id;

        // Generate steps via Claude
        const steps = await generatePlaybookSteps(trigger_type, context, integration);

        // Insert steps
        for (const step of steps) {
          await pool.query(
            `INSERT INTO playbook_steps (playbook_id, step_number, title, description, context_tip)
             VALUES ($1, $2, $3, $4, $5)`,
            [playbookId, step.step_number, step.title, step.description, step.context_tip || null]
          );
        }
      }
    }

    // --- 4. Return all playbooks with their steps ---
    const playbooks = await pool.query(
      `SELECT * FROM playbooks
       WHERE user_id = $1 AND integration = $2
       ORDER BY
         CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
         priority DESC,
         triggered_at DESC`,
      [userId, integration]
    );

    const steps = await pool.query(
      `SELECT ps.* FROM playbook_steps ps
       JOIN playbooks pb ON pb.id = ps.playbook_id
       WHERE pb.user_id = $1 AND pb.integration = $2
       ORDER BY ps.playbook_id, ps.step_number`,
      [userId, integration]
    );

    // Attach steps to their playbook
    const stepsMap = {};
    for (const step of steps.rows) {
      if (!stepsMap[step.playbook_id]) stepsMap[step.playbook_id] = [];
      stepsMap[step.playbook_id].push(step);
    }

    const result = playbooks.rows.map(pb => ({
      ...pb,
      steps: stepsMap[pb.id] || [],
    }));

    res.json({ playbooks: result });

  } catch (err) {
    console.error('GET /api/playbooks error:', err);
    res.status(500).json({ error: 'Failed to load playbooks' });
  }
});

// PATCH /api/playbooks/steps/:stepId/complete
// Toggle a single step complete/incomplete.

router.patch('/api/playbooks/steps/:stepId/complete', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { stepId } = req.params;
  const { is_complete } = req.body;

  try {
    // Verify the step belongs to this user
    const check = await pool.query(
      `SELECT ps.id FROM playbook_steps ps
       JOIN playbooks pb ON pb.id = ps.playbook_id
       WHERE ps.id = $1 AND pb.user_id = $2`,
      [stepId, userId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Step not found' });

    await pool.query(
      `UPDATE playbook_steps
       SET is_complete = $1, completed_at = $2
       WHERE id = $3`,
      [is_complete, is_complete ? new Date() : null, stepId]
    );

    // If all steps complete, mark the playbook complete
    const playbookId = (await pool.query(
      'SELECT playbook_id FROM playbook_steps WHERE id = $1', [stepId]
    )).rows[0].playbook_id;

    const remaining = await pool.query(
      'SELECT COUNT(*) FROM playbook_steps WHERE playbook_id = $1 AND is_complete = FALSE',
      [playbookId]
    );
    if (parseInt(remaining.rows[0].count) === 0) {
      await pool.query(
        `UPDATE playbooks SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [playbookId]
      );
    } else {
      // Ensure playbook is still active if a step was un-checked
      await pool.query(
        `UPDATE playbooks SET status = 'active', completed_at = NULL WHERE id = $1 AND status = 'completed'`,
        [playbookId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /steps/:stepId/complete error:', err);
    res.status(500).json({ error: 'Failed to update step' });
  }
});

// PATCH /api/playbooks/:id/dismiss
// Dismiss an active playbook.

router.patch('/api/playbooks/:id/dismiss', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE playbooks SET status = 'dismissed', dismissed_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Playbook not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /:id/dismiss error:', err);
    res.status(500).json({ error: 'Failed to dismiss playbook' });
  }
});

// ============================================================
// STORE DATA FETCHER
// Pulls the metrics needed for detection from your existing
// tables / Shopify endpoints. Adapt field names to match yours.
// ============================================================

async function fetchStoreDataForDetection(userId, integration, pool) {
  const storeRow = await pool.query(
    'SELECT * FROM connected_stores WHERE user_id = $1 AND platform = $2',
    [userId, integration]
  );
  if (!storeRow.rows.length) return {};

  const now   = new Date();
  const d7    = new Date(now - 7  * 24 * 60 * 60 * 1000);
  const d14   = new Date(now - 14 * 24 * 60 * 60 * 1000);
  const d30   = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const d60   = new Date(now - 60 * 24 * 60 * 60 * 1000);

  // These queries assume you cache order/inventory data locally.
  // If you query Shopify/Square APIs directly, replace with those calls.

  // Revenue: last 7d vs prior 7d
  // (Adapt table/column names to your schema)
  let revenue7d = null, revenuePrev7d = null;
  try {
    const r1 = await pool.query(
      `SELECT COALESCE(SUM(total_price),0) as rev FROM orders
       WHERE user_id=$1 AND created_at >= $2 AND created_at < $3`,
      [userId, d7, now]
    );
    const r2 = await pool.query(
      `SELECT COALESCE(SUM(total_price),0) as rev FROM orders
       WHERE user_id=$1 AND created_at >= $2 AND created_at < $3`,
      [userId, d14, d7]
    );
    revenue7d     = parseFloat(r1.rows[0].rev);
    revenuePrev7d = parseFloat(r2.rows[0].rev);
  } catch (_) {}

  // Low stock products (<=5 units)
  let lowStockProducts = [];
  try {
    const inv = await pool.query(
      `SELECT title, inventory_quantity FROM products
       WHERE user_id=$1 AND inventory_quantity <= 5 AND inventory_quantity >= 0
       ORDER BY inventory_quantity ASC LIMIT 10`,
      [userId]
    );
    lowStockProducts = inv.rows;
  } catch (_) {}

  // Repeat purchase rate: last 30d vs prior 30d
  let repeatRateCurrent = null, repeatRatePrev = null;
  try {
    const rr1 = await pool.query(
      `SELECT
         ROUND(100.0 * COUNT(DISTINCT CASE WHEN order_count > 1 THEN customer_id END)
               / NULLIF(COUNT(DISTINCT customer_id), 0), 1) as rate
       FROM (
         SELECT customer_id, COUNT(*) as order_count FROM orders
         WHERE user_id=$1 AND created_at >= $2 GROUP BY customer_id
       ) t`,
      [userId, d30]
    );
    const rr2 = await pool.query(
      `SELECT
         ROUND(100.0 * COUNT(DISTINCT CASE WHEN order_count > 1 THEN customer_id END)
               / NULLIF(COUNT(DISTINCT customer_id), 0), 1) as rate
       FROM (
         SELECT customer_id, COUNT(*) as order_count FROM orders
         WHERE user_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY customer_id
       ) t`,
      [userId, d60, d30]
    );
    repeatRateCurrent = parseFloat(rr1.rows[0].rate);
    repeatRatePrev    = parseFloat(rr2.rows[0].rate);
  } catch (_) {}

  // VIP customers quiet for 30+ days
  let vipCustomersQuiet = [];
  try {
    const vip = await pool.query(
      `SELECT customer_id, SUM(total_price) as ltv, MAX(created_at) as last_order
       FROM orders WHERE user_id=$1
       GROUP BY customer_id
       HAVING SUM(total_price) > 200 AND MAX(created_at) < $2
       ORDER BY ltv DESC LIMIT 20`,
      [userId, d30]
    );
    vipCustomersQuiet = vip.rows;
  } catch (_) {}

  return {
    revenue7d,
    revenuePrev7d,
    lowStockProducts,
    repeatRateCurrent,
    repeatRatePrev,
    vipCustomersQuiet,
    conversionCurrent: null, // wire up from your sessions data if available
    conversionPrev:    null,
  };
}

  return router;
};