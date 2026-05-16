const express = require('express');
const router = express.Router();
const pool = require('../db'); // your existing pg pool

// ─── PRODUCTS ───────────────────────────────────────────

// GET all products for a merchant
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
    res.status(500).json({ error: err.message });
  }
});

// POST create product (also seeds inventory row)
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT update product
router.put('/products/:id', async (req, res) => {
  const { id } = req.params;
  const { name, sku, category, description, sale_price, cost_price, unit, is_service } = req.body;
  try {
    const result = await pool.query(
      `UPDATE aervo_products
       SET name=$1, sku=$2, category=$3, description=$4,
           sale_price=$5, cost_price=$6, unit=$7, is_service=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [name, sku, category, description, sale_price, cost_price, unit, is_service, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE (soft delete) product
router.delete('/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`UPDATE aervo_products SET is_active=FALSE WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── INVENTORY ───────────────────────────────────────────

// POST adjust stock (restock, writeoff, correction)
router.post('/inventory/adjust', async (req, res) => {
  const { merchant_id, product_id, adjustment, reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE aervo_inventory
       SET quantity = quantity + $1, last_updated = NOW()
       WHERE product_id = $2`,
      [adjustment, product_id]
    );
    await client.query(
      `INSERT INTO aervo_inventory_adjustments (merchant_id, product_id, adjustment, reason)
       VALUES ($1, $2, $3, $4)`,
      [merchant_id, product_id, adjustment, reason]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET low stock alerts
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

router.put('/customers/:id', async (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, email, phone, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE aervo_customers
       SET first_name=$1, last_name=$2, email=$3, phone=$4, notes=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [first_name, last_name, email, phone, notes, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SALES ───────────────────────────────────────────────

// GET sales with optional date range
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
    res.status(500).json({ error: err.message });
  }
});

// POST log a sale (auto-deducts inventory)
router.post('/sales', async (req, res) => {
  const { merchant_id, customer_id, items, payment_method, notes, sale_date } = req.body;
  // items: [{ product_id, quantity, unit_price, unit_cost }]
  const client = await pool.connect();
  try {
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
      // Deduct inventory (skip for service items)
      await client.query(
        `UPDATE aervo_inventory
         SET quantity = quantity - $1, last_updated = NOW()
         WHERE product_id = $2`,
        [item.quantity, item.product_id]
      );
      // Log the adjustment
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

router.delete('/expenses/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`DELETE FROM aervo_expenses WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;