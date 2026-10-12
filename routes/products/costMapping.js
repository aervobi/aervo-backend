// ============================================================
// Aervo QuickBooks Integration — Product Cost Mapping
// File: routes/products/costMapping.js
// (spec names this routes/products/cost-mapping.js; renamed to match
// this repo's camelCase route file convention — csvUpload.js,
// healthScore.js, stickyFeatures.js — rather than the spec's hyphen.)
// See quickbooks-integration-spec.md sections 3 and 4.
// ============================================================

const express = require('express');

// ---- Auto-match logic (spec section 3) ----
// Compares aervo_products.sku to quickbooks_items.sku (case-insensitive,
// trimmed). Exact matches get match_type='auto'. Products with no match
// still get a row so the mapping UI has something to list. Existing
// 'manual' mappings are never overwritten by auto-matching, and an
// existing 'unmatched'/'auto' row isn't re-created if one already
// exists — this runs after every sync (scripts/sync-quickbooks.js),
// not on every page load, so it only needs to fill in what's new.
async function autoMatchProducts(pool, userId) {
  const [{ rows: products }, { rows: items }] = await Promise.all([
    pool.query(
      `SELECT id, sku FROM aervo_products WHERE merchant_id = $1 AND is_active = TRUE`,
      [userId]
    ),
    pool.query(
      `SELECT quickbooks_item_id, sku FROM quickbooks_items WHERE user_id = $1 AND sku IS NOT NULL`,
      [userId]
    ),
  ]);

  const itemIdBySku = new Map();
  for (const item of items) {
    const key = item.sku.trim().toLowerCase();
    if (key) itemIdBySku.set(key, item.quickbooks_item_id);
  }

  let autoMatched = 0;
  let created = 0;

  for (const product of products) {
    const key = product.sku ? product.sku.trim().toLowerCase() : null;
    const matchedItemId = key ? itemIdBySku.get(key) : undefined;

    if (matchedItemId) {
      const result = await pool.query(
        `INSERT INTO product_cost_mappings (user_id, aervo_product_id, quickbooks_item_id, match_type, updated_at)
         VALUES ($1, $2, $3, 'auto', NOW())
         ON CONFLICT (user_id, aervo_product_id) DO UPDATE SET
           quickbooks_item_id = EXCLUDED.quickbooks_item_id,
           match_type = 'auto',
           updated_at = NOW()
         WHERE product_cost_mappings.match_type <> 'manual'
         RETURNING id`,
        [userId, product.id, matchedItemId]
      );
      if (result.rows.length) autoMatched++;
    } else {
      const result = await pool.query(
        `INSERT INTO product_cost_mappings (user_id, aervo_product_id, quickbooks_item_id, match_type, updated_at)
         VALUES ($1, $2, NULL, 'unmatched', NOW())
         ON CONFLICT (user_id, aervo_product_id) DO NOTHING
         RETURNING id`,
        [userId, product.id]
      );
      if (result.rows.length) created++;
    }
  }

  return { productCount: products.length, autoMatched, created };
}

module.exports = function (pool, authenticateToken) {
  const router = express.Router();

  // ============================================================
  // GET /api/products/cost-mapping
  // Every active product with its current mapping status, plus the
  // full list of synced QuickBooks items for the mapping dropdown.
  // Doesn't run auto-match itself (that's tied to the nightly sync) —
  // a product with no mapping row yet just shows as unmatched.
  // ============================================================
  router.get('/api/products/cost-mapping', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    try {
      const [{ rows: products }, { rows: items }] = await Promise.all([
        pool.query(
          `SELECT
             p.id AS aervo_product_id,
             p.name,
             p.sku,
             COALESCE(m.match_type, 'unmatched') AS match_type,
             m.quickbooks_item_id,
             qi.name AS quickbooks_item_name
           FROM aervo_products p
           LEFT JOIN product_cost_mappings m
             ON m.aervo_product_id = p.id AND m.user_id = $1
           LEFT JOIN quickbooks_items qi
             ON qi.quickbooks_item_id = m.quickbooks_item_id AND qi.user_id = $1
           WHERE p.merchant_id = $1 AND p.is_active = TRUE
           ORDER BY p.name ASC`,
          [userId]
        ),
        pool.query(
          `SELECT quickbooks_item_id, name, sku FROM quickbooks_items WHERE user_id = $1 ORDER BY name ASC`,
          [userId]
        ),
      ]);

      res.json({ success: true, products, available_items: items });
    } catch (err) {
      console.error('Error fetching product cost mappings', { userId, error: err.message });
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  // ============================================================
  // POST /api/products/cost-mapping/:productId
  // body: { quickbooks_item_id } — sets match_type = 'manual'
  // ============================================================
  router.post('/api/products/cost-mapping/:productId', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { productId } = req.params;
    const { quickbooks_item_id } = req.body;

    if (!quickbooks_item_id) {
      return res.status(400).json({ success: false, message: 'quickbooks_item_id is required' });
    }

    try {
      const product = await pool.query(
        `SELECT id FROM aervo_products WHERE id = $1 AND merchant_id = $2`,
        [productId, userId]
      );
      if (!product.rows.length) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }

      const item = await pool.query(
        `SELECT quickbooks_item_id FROM quickbooks_items WHERE quickbooks_item_id = $1 AND user_id = $2`,
        [quickbooks_item_id, userId]
      );
      if (!item.rows.length) {
        return res.status(404).json({ success: false, message: 'QuickBooks item not found' });
      }

      await pool.query(
        `INSERT INTO product_cost_mappings (user_id, aervo_product_id, quickbooks_item_id, match_type, updated_at)
         VALUES ($1, $2, $3, 'manual', NOW())
         ON CONFLICT (user_id, aervo_product_id) DO UPDATE SET
           quickbooks_item_id = EXCLUDED.quickbooks_item_id,
           match_type          = 'manual',
           updated_at          = NOW()`,
        [userId, productId, quickbooks_item_id]
      );

      res.json({ success: true, message: 'Mapping updated' });
    } catch (err) {
      console.error('Error setting product cost mapping', { userId, productId, error: err.message });
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  // ============================================================
  // DELETE /api/products/cost-mapping/:productId
  // Clears a mapping, reverting it to unmatched.
  // ============================================================
  router.delete('/api/products/cost-mapping/:productId', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { productId } = req.params;

    try {
      const result = await pool.query(
        `UPDATE product_cost_mappings
         SET quickbooks_item_id = NULL, match_type = 'unmatched', updated_at = NOW()
         WHERE user_id = $1 AND aervo_product_id = $2
         RETURNING id`,
        [userId, productId]
      );

      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Mapping not found' });
      }

      res.json({ success: true, message: 'Mapping cleared' });
    } catch (err) {
      console.error('Error clearing product cost mapping', { userId, productId, error: err.message });
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  return router;
};

module.exports.autoMatchProducts = autoMatchProducts;
