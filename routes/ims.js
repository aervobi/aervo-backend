const express = require('express');

module.exports = function(pool, authenticateToken) {
  const router = express.Router();

  // Every IMS route requires a login, and the merchant is always the logged-in
  // user. A client that sends a different merchant_id is refused; one that
  // sends none (or its own) is handled identically, so existing pages keep working.
  router.use(authenticateToken);
  router.use((req, res, next) => {
    const own = req.user.userId;
    const supplied = req.query.merchant_id ?? (req.body && req.body.merchant_id);
    if (supplied !== undefined && supplied !== null && supplied !== '' && String(supplied) !== String(own)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    req.query.merchant_id = String(own);
    if (req.body && typeof req.body === 'object') req.body.merchant_id = own;
    next();
  });

  // Log the real error, return a generic one (no SQL/internal detail to clients).
  const fail = (res, err) => {
    console.error('IMS error:', err.message);
    res.status(500).json({ error: 'Something went wrong' });
  };

  // ─── PRODUCTS ───────────────────────────────────────────

  router.get('/products', async (req, res) => {
    const { merchant_id } = req.query;
    try {
      const result = await pool.query(
        `SELECT p.*, i.quantity, i.low_stock_threshold
         FROM aervo_products p
         LEFT JOIN aervo_inventory i ON i.product_id = p.id
         WHERE p.merchant_id = $1 AND p.is_active = TRUE
         ORDER BY p.name ASC`,
        [merchant_id]
      );
      res.json(result.rows);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/products', async (req, res) => {
    const { merchant_id, name, sku, category, description,
            sale_price, cost_price, unit, is_service, initial_quantity, low_stock_threshold } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const productResult = await client.query(
        `INSERT INTO aervo_products
          (merchant_id, name, sku, category, description, sale_price, cost_price, unit, is_service)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [merchant_id, name, sku, category, description, sale_price, cost_price, unit, is_service || false]
      );
      const product = productResult.rows[0];

      await client.query(
        `INSERT INTO aervo_inventory (merchant_id, product_id, quantity, low_stock_threshold)
         VALUES ($1, $2, $3, $4)`,
        [merchant_id, product.id, initial_quantity || 0, low_stock_threshold || 10]
      );

      await client.query('COMMIT');
      res.status(201).json(product);
    } catch (err) {
      await client.query('ROLLBACK');
      fail(res, err);
    } finally {
      client.release();
    }
  });

  router.put('/products/:id', async (req, res) => {
    const { id } = req.params;
    const { name, sku, category, description, sale_price, cost_price, unit, is_service } = req.body;
    try {
      const result = await pool.query(
        `UPDATE aervo_products
         SET name=$1, sku=$2, category=$3, description=$4,
             sale_price=$5, cost_price=$6, unit=$7, is_service=$8, updated_at=NOW()
         WHERE id=$9 AND merchant_id=$10 RETURNING *`,
        [name, sku, category, description, sale_price, cost_price, unit, is_service, id, req.body.merchant_id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json(result.rows[0]);
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/products/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        `UPDATE aervo_products SET is_active=FALSE WHERE id=$1 AND merchant_id=$2`,
        [id, req.query.merchant_id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ─── INVENTORY ───────────────────────────────────────────

  router.post('/inventory/adjust', async (req, res) => {
    const { merchant_id, product_id, adjustment, reason } = req.body;
    if (!Number.isFinite(Number(adjustment))) return res.status(400).json({ error: 'Invalid adjustment' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE aervo_inventory
         SET quantity = quantity + $1, last_updated = NOW()
         WHERE product_id = $2 AND merchant_id = $3`,
        [adjustment, product_id, merchant_id]
      );
      if (updated.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      await client.query(
        `INSERT INTO aervo_inventory_adjustments (merchant_id, product_id, adjustment, reason)
         VALUES ($1, $2, $3, $4)`,
        [merchant_id, product_id, adjustment, reason]
      );
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      fail(res, err);
    } finally {
      client.release();
    }
  });

  router.get('/inventory/low-stock', async (req, res) => {
    const { merchant_id } = req.query;
    try {
      const result = await pool.query(
        `SELECT p.name, p.sku, p.category, i.quantity, i.low_stock_threshold
         FROM aervo_inventory i
         JOIN aervo_products p ON p.id = i.product_id
         WHERE p.merchant_id = $1 AND i.quantity <= i.low_stock_threshold AND p.is_active = TRUE
         ORDER BY i.quantity ASC`,
        [merchant_id]
      );
      res.json(result.rows);
    } catch (err) {
      fail(res, err);
    }
  });

  // ─── CUSTOMERS ───────────────────────────────────────────

  router.get('/customers', async (req, res) => {
    const { merchant_id } = req.query;
    try {
      const result = await pool.query(
        `SELECT c.*,
          COUNT(s.id) AS total_orders,
          COALESCE(SUM(s.total_amount), 0) AS total_spent
         FROM aervo_customers c
         LEFT JOIN aervo_sales s ON s.customer_id = c.id
         WHERE c.merchant_id = $1
         GROUP BY c.id
         ORDER BY c.created_at DESC`,
        [merchant_id]
      );
      res.json(result.rows);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/customers', async (req, res) => {
    const { merchant_id, first_name, last_name, email, phone, notes } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO aervo_customers (merchant_id, first_name, last_name, email, phone, notes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [merchant_id, first_name, last_name, email, phone, notes]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/customers/:id', async (req, res) => {
    const { id } = req.params;
    const { first_name, last_name, email, phone, notes } = req.body;
    try {
      const result = await pool.query(
        `UPDATE aervo_customers
         SET first_name=$1, last_name=$2, email=$3, phone=$4, notes=$5, updated_at=NOW()
         WHERE id=$6 AND merchant_id=$7 RETURNING *`,
        [first_name, last_name, email, phone, notes, id, req.body.merchant_id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json(result.rows[0]);
    } catch (err) {
      fail(res, err);
    }
  });

  // ─── SALES ───────────────────────────────────────────────

  router.get('/sales', async (req, res) => {
    const { merchant_id, from, to } = req.query;
    try {
      const result = await pool.query(
        `SELECT s.*,
          c.first_name, c.last_name,
          json_agg(json_build_object(
            'product_id', si.product_id,
            'product_name', p.name,
            'quantity', si.quantity,
            'unit_price', si.unit_price,
            'line_total', si.line_total
          )) AS items
         FROM aervo_sales s
         LEFT JOIN aervo_customers c ON c.id = s.customer_id
         LEFT JOIN aervo_sale_items si ON si.sale_id = s.id
         LEFT JOIN aervo_products p ON p.id = si.product_id
         WHERE s.merchant_id = $1
           AND ($2::date IS NULL OR s.sale_date >= $2::date)
           AND ($3::date IS NULL OR s.sale_date <= $3::date)
         GROUP BY s.id, c.first_name, c.last_name
         ORDER BY s.sale_date DESC`,
        [merchant_id, from || null, to || null]
      );
      res.json(result.rows);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/sales', async (req, res) => {
    const { merchant_id, customer_id, items, payment_method, notes, sale_date } = req.body;
    const validItems =
      Array.isArray(items) &&
      items.length > 0 &&
      items.every(
        (i) =>
          Number(i.product_id) > 0 &&
          Number.isFinite(Number(i.quantity)) && Number(i.quantity) > 0 &&
          Number.isFinite(Number(i.unit_price)) && Number(i.unit_price) >= 0 &&
          Number.isFinite(Number(i.unit_cost)) && Number(i.unit_cost) >= 0
      );
    if (!validItems) return res.status(400).json({ error: 'Invalid sale items' });
    const client = await pool.connect();
    try {
      // Everything referenced must belong to this merchant
      const ids = [...new Set(items.map((i) => Number(i.product_id)))];
      const owned = await client.query(
        `SELECT COUNT(*)::int AS n FROM aervo_products WHERE id = ANY($1::int[]) AND merchant_id = $2`,
        [ids, merchant_id]
      );
      if (owned.rows[0].n !== ids.length) {
        return res.status(404).json({ error: 'Product not found' });
      }
      if (customer_id) {
        const c = await client.query(
          `SELECT 1 FROM aervo_customers WHERE id = $1 AND merchant_id = $2`,
          [customer_id, merchant_id]
        );
        if (c.rows.length === 0) {
          return res.status(404).json({ error: 'Customer not found' });
        }
      }
      await client.query('BEGIN');

      const total_amount = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
      const total_cost   = items.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0);

      const saleResult = await client.query(
        `INSERT INTO aervo_sales (merchant_id, customer_id, total_amount, total_cost, payment_method, notes, sale_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [merchant_id, customer_id || null, total_amount, total_cost,
         payment_method || 'cash', notes || null, sale_date || new Date()]
      );
      const sale = saleResult.rows[0];

      for (const item of items) {
        const line_total = item.quantity * item.unit_price;
        await client.query(
          `INSERT INTO aervo_sale_items (sale_id, product_id, quantity, unit_price, unit_cost, line_total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [sale.id, item.product_id, item.quantity, item.unit_price, item.unit_cost, line_total]
        );
        await client.query(
          `UPDATE aervo_inventory
           SET quantity = quantity - $1, last_updated = NOW()
           WHERE product_id = $2 AND merchant_id = $3`,
          [item.quantity, item.product_id, merchant_id]
        );
        await client.query(
          `INSERT INTO aervo_inventory_adjustments (merchant_id, product_id, adjustment, reason, reference_id)
           VALUES ($1,$2,$3,'sale',$4)`,
          [merchant_id, item.product_id, -item.quantity, sale.id]
        );
      }

      await client.query('COMMIT');
      res.status(201).json(sale);
    } catch (err) {
      await client.query('ROLLBACK');
      fail(res, err);
    } finally {
      client.release();
    }
  });

  // ─── EXPENSES ────────────────────────────────────────────

  router.get('/expenses', async (req, res) => {
    const { merchant_id, from, to } = req.query;
    try {
      const result = await pool.query(
        `SELECT * FROM aervo_expenses
         WHERE merchant_id = $1
           AND ($2::date IS NULL OR expense_date >= $2::date)
           AND ($3::date IS NULL OR expense_date <= $3::date)
         ORDER BY expense_date DESC`,
        [merchant_id, from || null, to || null]
      );
      res.json(result.rows);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/expenses', async (req, res) => {
    const { merchant_id, category, description, amount, expense_date } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO aervo_expenses (merchant_id, category, description, amount, expense_date)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [merchant_id, category, description, amount, expense_date || new Date()]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/expenses/:id', async (req, res) => {
  const { id } = req.params;
  const { category, description, amount, expense_date } = req.body;
  try {
    const result = await pool.query(
      `UPDATE aervo_expenses
       SET category=$1, description=$2, amount=$3, expense_date=$4
       WHERE id=$5 AND merchant_id=$6 RETURNING *`,
      [category, description, amount, expense_date, id, req.body.merchant_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    fail(res, err);
  }
});

  router.delete('/expenses/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        `DELETE FROM aervo_expenses WHERE id=$1 AND merchant_id=$2`,
        [id, req.query.merchant_id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ─── ANALYTICS (feeds the unified dashboard) ─────────────

  router.get('/analytics/summary', async (req, res) => {
    const { merchant_id, from, to } = req.query;
    try {
      const revenue = await pool.query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total_revenue,
                COALESCE(SUM(total_cost), 0) AS total_cogs,
                COUNT(*) AS total_orders
         FROM aervo_sales
         WHERE merchant_id=$1
           AND ($2::date IS NULL OR sale_date >= $2::date)
           AND ($3::date IS NULL OR sale_date <= $3::date)`,
        [merchant_id, from || null, to || null]
      );

      const expenses = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_expenses
         FROM aervo_expenses
         WHERE merchant_id=$1
           AND ($2::date IS NULL OR expense_date >= $2::date)
           AND ($3::date IS NULL OR expense_date <= $3::date)`,
        [merchant_id, from || null, to || null]
      );

      const topProducts = await pool.query(
        `SELECT p.name, SUM(si.quantity) AS units_sold,
                SUM(si.line_total) AS revenue
         FROM aervo_sale_items si
         JOIN aervo_products p ON p.id = si.product_id
         JOIN aervo_sales s ON s.id = si.sale_id
         WHERE s.merchant_id=$1
           AND ($2::date IS NULL OR s.sale_date >= $2::date)
           AND ($3::date IS NULL OR s.sale_date <= $3::date)
         GROUP BY p.name
         ORDER BY revenue DESC LIMIT 5`,
        [merchant_id, from || null, to || null]
      );

      const { total_revenue, total_cogs, total_orders } = revenue.rows[0];
      const { total_expenses } = expenses.rows[0];
      const gross_profit = total_revenue - total_cogs;
      const net_profit   = gross_profit - total_expenses;

      res.json({
        total_revenue,
        total_cogs,
        gross_profit,
        total_expenses,
        net_profit,
        total_orders,
        top_products: topProducts.rows
      });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
};