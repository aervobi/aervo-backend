// Builds the "what do we know about this business" text that the AI assistants
// are given. One builder per data source; every query is scoped to the merchant
// id passed in, and callers must pass the logged-in user's own id.
const money = (n) =>
  "$" + (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
const num = (v) => Number(v) || 0;
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "n/a");

// ── Square (amounts are stored in cents) ─────────────────────────────────────
async function squareContext(pool, merchantId) {
  const [revenue, orders, customers, topItems, hourly] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(gross_amount), 0) AS total_revenue
       FROM square_order_line_items WHERE aervo_merchant_id = $1`,
      [merchantId]
    ),
    pool.query(
      `SELECT AVG(total_amount) AS avg_order_value,
              DATE_TRUNC('month', created_at) AS month,
              COUNT(*) AS monthly_orders
       FROM square_orders WHERE aervo_merchant_id = $1
       GROUP BY DATE_TRUNC('month', created_at) ORDER BY month DESC LIMIT 12`,
      [merchantId]
    ),
    pool.query(
      `SELECT COUNT(*) AS total_customers,
              COUNT(CASE WHEN total_visit_count > 1 THEN 1 END) AS returning_customers
       FROM square_customers WHERE aervo_merchant_id = $1`,
      [merchantId]
    ),
    pool.query(
      `SELECT name, COUNT(*) AS orders, SUM(gross_amount) AS revenue
       FROM square_order_line_items WHERE aervo_merchant_id = $1
       GROUP BY name ORDER BY orders DESC LIMIT 10`,
      [merchantId]
    ),
    pool.query(
      `SELECT EXTRACT(HOUR FROM created_at) AS hour, COUNT(*) AS orders
       FROM square_orders WHERE aervo_merchant_id = $1
       GROUP BY hour ORDER BY orders DESC`,
      [merchantId]
    ),
  ]);

  const totalRevenue = num(revenue.rows[0]?.total_revenue) / 100;
  const totalCustomers = num(customers.rows[0]?.total_customers);
  const returning = num(customers.rows[0]?.returning_customers);
  const monthly = orders.rows.map((r) => ({
    month: r.month ? new Date(r.month).toISOString().slice(0, 7) : "?",
    orders: num(r.monthly_orders),
    avg: num(r.avg_order_value) / 100,
  }));
  const totalOrders = monthly.reduce((a, m) => a + m.orders, 0);

  if (totalOrders === 0 && totalCustomers === 0) {
    return "DATA SOURCE: Square. No Square orders or customers have been synced yet.";
  }

  return `DATA SOURCE: Square point of sale.

OVERVIEW:
- Total revenue: ${money(totalRevenue)}
- Total orders: ${totalOrders}
- Customers: ${totalCustomers} (${returning} returning, retention ${pct(returning, totalCustomers)})

MONTHLY ORDER TRENDS (last 12 months):
${monthly.map((m) => `- ${m.month}: ${m.orders} orders, avg ${money(m.avg)}/order`).join("\n") || "- none"}

TOP SERVICES/ITEMS:
${topItems.rows.map((r, i) => `${i + 1}. ${r.name}: ${num(r.orders)} orders, ${money(num(r.revenue) / 100)} revenue`).join("\n") || "- none"}

BUSIEST HOURS:
${hourly.rows.slice(0, 3).map((r) => `- ${r.hour}:00: ${num(r.orders)} orders`).join("\n") || "- none"}`;
}

// ── Aervo Inventory Management System (amounts are dollars) ──────────────────
async function imsContext(pool, userId) {
  const id = Number(userId);
  const [last30, allTime, monthly, expenses, topProducts, lowStock, stock, customers, repeat] =
    await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(total_amount),0) AS rev, COALESCE(SUM(total_cost),0) AS cogs, COUNT(*) AS n
         FROM aervo_sales WHERE merchant_id = $1 AND sale_date >= NOW() - INTERVAL '30 days'`,
        [id]
      ),
      pool.query(
        `SELECT COALESCE(SUM(total_amount),0) AS rev, COALESCE(SUM(total_cost),0) AS cogs, COUNT(*) AS n
         FROM aervo_sales WHERE merchant_id = $1`,
        [id]
      ),
      pool.query(
        `SELECT DATE_TRUNC('month', sale_date) AS m, SUM(total_amount) AS rev,
                SUM(total_cost) AS cogs, COUNT(*) AS n
         FROM aervo_sales WHERE merchant_id = $1 GROUP BY m ORDER BY m DESC LIMIT 6`,
        [id]
      ),
      pool.query(
        `SELECT category, SUM(amount) AS total FROM aervo_expenses
         WHERE merchant_id = $1 AND expense_date >= NOW() - INTERVAL '90 days'
         GROUP BY category ORDER BY total DESC LIMIT 8`,
        [id]
      ),
      pool.query(
        `SELECT p.name, SUM(si.quantity) AS units, SUM(si.line_total) AS revenue,
                SUM(si.line_total - si.quantity * si.unit_cost) AS profit
         FROM aervo_sale_items si
         JOIN aervo_sales s ON s.id = si.sale_id
         JOIN aervo_products p ON p.id = si.product_id
         WHERE s.merchant_id = $1 AND s.sale_date >= NOW() - INTERVAL '90 days'
         GROUP BY p.name ORDER BY revenue DESC LIMIT 8`,
        [id]
      ),
      pool.query(
        `SELECT p.name, i.quantity, i.low_stock_threshold
         FROM aervo_inventory i JOIN aervo_products p ON p.id = i.product_id
         WHERE p.merchant_id = $1 AND p.is_active = TRUE AND i.quantity <= i.low_stock_threshold
         ORDER BY i.quantity ASC LIMIT 10`,
        [id]
      ),
      pool.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(i.quantity * p.cost_price), 0) AS value
         FROM aervo_products p LEFT JOIN aervo_inventory i ON i.product_id = p.id
         WHERE p.merchant_id = $1 AND p.is_active = TRUE`,
        [id]
      ),
      pool.query(`SELECT COUNT(*) AS n FROM aervo_customers WHERE merchant_id = $1`, [id]),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE c > 1) AS repeat, COUNT(*) AS buyers FROM (
           SELECT customer_id, COUNT(*) AS c FROM aervo_sales
           WHERE merchant_id = $1 AND customer_id IS NOT NULL GROUP BY customer_id) t`,
        [id]
      ),
    ]);

  const a = allTime.rows[0] || {};
  if (num(a.n) === 0 && num(stock.rows[0]?.n) === 0) {
    return "DATA SOURCE: Aervo Inventory Management System. No products or sales have been recorded yet.";
  }

  const l = last30.rows[0] || {};
  const rev30 = num(l.rev), cogs30 = num(l.cogs), n30 = num(l.n);
  const exp30 = (
    await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS t FROM aervo_expenses
       WHERE merchant_id = $1 AND expense_date >= NOW() - INTERVAL '30 days'`,
      [id]
    )
  ).rows[0];

  return `DATA SOURCE: Aervo Inventory Management System (manually recorded sales, expenses and stock). All amounts are in dollars.

LAST 30 DAYS:
- Revenue: ${money(rev30)} from ${n30} sales (avg ${money(n30 ? rev30 / n30 : 0)})
- Cost of goods: ${money(cogs30)}; gross profit ${money(rev30 - cogs30)} (margin ${pct(rev30 - cogs30, rev30)})
- Expenses: ${money(exp30?.t)}; net profit ${money(rev30 - cogs30 - num(exp30?.t))}

ALL TIME: ${money(a.rev)} revenue from ${num(a.n)} sales, gross profit ${money(num(a.rev) - num(a.cogs))}

MONTHLY (most recent first):
${monthly.rows.map((r) => `- ${new Date(r.m).toISOString().slice(0, 7)}: ${money(r.rev)} revenue, ${money(num(r.rev) - num(r.cogs))} gross profit, ${num(r.n)} sales`).join("\n") || "- none"}

EXPENSES BY CATEGORY (last 90 days):
${expenses.rows.map((r) => `- ${r.category || "Uncategorized"}: ${money(r.total)}`).join("\n") || "- none"}

TOP PRODUCTS (last 90 days):
${topProducts.rows.map((r, i) => `${i + 1}. ${r.name}: ${num(r.units)} units, ${money(r.revenue)} revenue, ${money(r.profit)} profit`).join("\n") || "- none"}

LOW STOCK (at or below reorder level):
${lowStock.rows.map((r) => `- ${r.name}: ${num(r.quantity)} left (reorder at ${num(r.low_stock_threshold)})`).join("\n") || "- none"}

INVENTORY: ${num(stock.rows[0]?.n)} active products, stock valued at cost ${money(stock.rows[0]?.value)}

CUSTOMERS: ${num(customers.rows[0]?.n)} on file; ${num(repeat.rows[0]?.repeat)} of ${num(repeat.rows[0]?.buyers)} buyers purchased more than once (${pct(num(repeat.rows[0]?.repeat), num(repeat.rows[0]?.buyers))})`;
}

// Turns client-supplied chat history into a valid message list for Claude: only
// user/assistant roles, bounded length, starts with a user turn, alternates, and
// ends with the current user message.
function buildMessages(history, message, { keep = 6, maxLen = 2000 } = {}) {
  const clean = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, maxLen) }))
    .slice(-keep);
  while (clean.length && clean[0].role !== "user") clean.shift();
  const out = [];
  for (const m of clean) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n" + m.content;
    else out.push(m);
  }
  if (out.length && out[out.length - 1].role === "user") out.pop(); // the current message replaces a dangling one
  out.push({ role: "user", content: String(message).trim().slice(0, maxLen) });
  return out;
}

module.exports = { squareContext, imsContext, buildMessages, money };
