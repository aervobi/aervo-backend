const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { authenticateToken } = require("../middleware/auth");
const { planFor, historyStart } = require("../utils/planAccess");
const { getValidShopifyToken, shopifyFetch } = require("../utils/shopifyToken");
const { isValidTimeZone, localDate, addDays, dayRange } = require("../utils/tzdate");

// One view of sales across every way the business sells: Square (synced into
// our tables), Shopify (read live from each connected store) and the IMS
// (manual sales). Each source is summarised on its own so the page can show
// them together or one at a time; amounts are in dollars.

const DAY_OPTIONS = [7, 30, 90];
const SHOPIFY_MAX_PAGES = 10; // 250 orders a page, per store
const TOP_N = 10;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function emptySummary() {
  return { revenue: 0, orders: 0, customers: 0 };
}

// Which sources this account has
async function sourcesFor(userId) {
  const [user, square, shops, ims] = await Promise.all([
    pool.query("SELECT platform FROM users WHERE id = $1", [userId]),
    pool.query("SELECT 1 FROM square_connections WHERE aervo_merchant_id = $1 LIMIT 1", [String(userId)]),
    pool.query("SELECT shop_origin, store_name FROM shops WHERE user_id = $1 ORDER BY shop_origin", [userId]),
    pool.query(
      `SELECT EXISTS (SELECT 1 FROM aervo_sales WHERE merchant_id = $1)
           OR EXISTS (SELECT 1 FROM aervo_products WHERE merchant_id = $1) AS used`,
      [userId]
    ),
  ]);
  const platform = user.rows[0] && user.rows[0].platform;
  return {
    square: square.rows.length > 0,
    shops: shops.rows,
    ims: platform === "csv" || platform === "ims" || !!(ims.rows[0] && ims.rows[0].used),
  };
}

// ── Square ────────────────────────────────────────────────────────────────────
// Revenue is the sum of line-item gross sales, the same figure the Square
// dashboard shows (amounts are stored in cents).
async function squareData(userId, w) {
  const merchantId = String(userId);
  const orderTotals = `
    SELECT o.square_order_id, o.square_customer_id, o.created_at,
           COALESCE(SUM(li.gross_amount::numeric), 0) / 100 AS total
      FROM square_orders o
      LEFT JOIN square_order_line_items li ON li.square_order_id = o.square_order_id
     WHERE o.aervo_merchant_id = $1 AND o.created_at >= $2 AND o.created_at < $3
     GROUP BY o.square_order_id, o.square_customer_id, o.created_at`;

  const summary = (start, end) =>
    pool
      .query(
        `SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders,
                COUNT(DISTINCT square_customer_id) AS customers
           FROM (${orderTotals}) t`,
        [merchantId, start, end]
      )
      .then((r) => r.rows[0]);

  const [cur, prev, daily, top] = await Promise.all([
    summary(w.start, w.end),
    w.compare ? summary(w.prevStart, w.start) : null,
    pool.query(
      `SELECT to_char((created_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
              SUM(total) AS revenue, COUNT(*) AS orders
         FROM (${orderTotals}) t
        GROUP BY 1`,
      [merchantId, w.start, w.end, w.tz]
    ),
    pool.query(
      `SELECT li.name, SUM(li.quantity) AS units, SUM(li.gross_amount::numeric) / 100 AS revenue
         FROM square_order_line_items li
         JOIN square_orders o ON o.square_order_id = li.square_order_id
        WHERE o.aervo_merchant_id = $1 AND o.created_at >= $2 AND o.created_at < $3
          AND li.name IS NOT NULL AND li.name <> '' AND li.name <> 'Tip'
        GROUP BY li.name
        ORDER BY revenue DESC
        LIMIT ${TOP_N}`,
      [merchantId, w.start, w.end]
    ),
  ]);

  return {
    summary: { revenue: round2(cur.revenue), orders: +cur.orders, customers: +cur.customers },
    previous: prev && { revenue: round2(prev.revenue), orders: +prev.orders, customers: +prev.customers },
    daily: daily.rows.map((r) => ({ date: r.day, revenue: round2(r.revenue), orders: +r.orders })),
    topProducts: top.rows.map((r) => ({ name: r.name, units: +r.units || 0, revenue: round2(r.revenue) })),
  };
}

// ── Shopify ───────────────────────────────────────────────────────────────────
// Orders are read live (status=any, like the Shopify dashboard), following the
// Link header for further pages.
async function shopifyOrders(shop, since, until) {
  const token = await getValidShopifyToken(pool, shop);
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-10";
  let url =
    `https://${shop}/admin/api/${apiVersion}/orders.json?status=any&limit=250` +
    `&created_at_min=${since.toISOString()}&created_at_max=${until.toISOString()}` +
    `&fields=id,created_at,total_price,customer,line_items`;
  const orders = [];
  let truncated = false;
  for (let page = 0; url; page++) {
    if (page === SHOPIFY_MAX_PAGES) {
      truncated = true;
      break;
    }
    const resp = await shopifyFetch(pool, shop, url, { headers: { "X-Shopify-Access-Token": token } });
    if (!resp.ok) throw new Error(`Shopify ${resp.status}`);
    orders.push(...((await resp.json()).orders || []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(resp.headers.get("link") || "");
    url = next ? next[1] : null;
  }
  return { orders, truncated };
}

async function shopifyData(shops, w) {
  const all = [];
  const notes = [];
  const failed = [];
  await Promise.all(
    shops.map(async (s) => {
      const name = s.store_name || s.shop_origin;
      try {
        const r = await shopifyOrders(s.shop_origin, w.compare ? w.prevStart : w.start, w.end);
        all.push(...r.orders);
        if (r.truncated) notes.push(`${name} has more orders than we read at once; totals cover the most recent ones.`);
      } catch (err) {
        console.error("Unified Shopify error:", s.shop_origin, err.message);
        failed.push(name);
      }
    })
  );
  if (failed.length === shops.length) throw new Error("No Shopify store could be read");
  if (failed.length) notes.push(`Couldn't read ${failed.join(", ")} right now.`);

  const cur = emptySummary();
  const prev = emptySummary();
  const curCustomers = new Set();
  const prevCustomers = new Set();
  const days = {};
  const products = {};

  for (const o of all) {
    const at = new Date(o.created_at);
    const total = parseFloat(o.total_price || 0);
    const customerId = o.customer && o.customer.id;
    if (at >= w.start) {
      cur.revenue += total;
      cur.orders += 1;
      if (customerId) curCustomers.add(customerId);
      const day = localDate(at, w.tz);
      days[day] = days[day] || { date: day, revenue: 0, orders: 0 };
      days[day].revenue += total;
      days[day].orders += 1;
      for (const li of o.line_items || []) {
        const name = li.title || "Item";
        products[name] = products[name] || { name, units: 0, revenue: 0 };
        products[name].units += li.quantity || 0;
        products[name].revenue += parseFloat(li.price || 0) * (li.quantity || 0);
      }
    } else {
      prev.revenue += total;
      prev.orders += 1;
      if (customerId) prevCustomers.add(customerId);
    }
  }
  cur.customers = curCustomers.size;
  prev.customers = prevCustomers.size;

  return {
    summary: { ...cur, revenue: round2(cur.revenue) },
    previous: w.compare ? { ...prev, revenue: round2(prev.revenue) } : null,
    daily: Object.values(days).map((d) => ({ ...d, revenue: round2(d.revenue) })),
    topProducts: Object.values(products)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, TOP_N)
      .map((p) => ({ ...p, revenue: round2(p.revenue) })),
    stores: shops.map((s) => s.store_name || s.shop_origin),
    notes,
  };
}

// ── IMS ───────────────────────────────────────────────────────────────────────
// Manual sales carry a calendar date (no time), so the window is by date.
async function imsData(userId, w) {
  const summary = (from, to) =>
    pool
      .query(
        `SELECT COALESCE(SUM(total_amount), 0) AS revenue, COUNT(*) AS orders,
                COUNT(DISTINCT customer_id) AS customers
           FROM aervo_sales
          WHERE merchant_id = $1 AND sale_date >= $2::date AND sale_date <= $3::date`,
        [userId, from, to]
      )
      .then((r) => r.rows[0]);

  const [cur, prev, daily, top] = await Promise.all([
    summary(w.fromDate, w.toDate),
    w.compare ? summary(w.prevFromDate, addDays(w.fromDate, -1)) : null,
    pool.query(
      `SELECT to_char(sale_date, 'YYYY-MM-DD') AS day, SUM(total_amount) AS revenue, COUNT(*) AS orders
         FROM aervo_sales
        WHERE merchant_id = $1 AND sale_date >= $2::date AND sale_date <= $3::date
        GROUP BY 1`,
      [userId, w.fromDate, w.toDate]
    ),
    pool.query(
      `SELECT p.name, SUM(si.quantity) AS units, SUM(si.line_total) AS revenue
         FROM aervo_sale_items si
         JOIN aervo_products p ON p.id = si.product_id
         JOIN aervo_sales s ON s.id = si.sale_id
        WHERE s.merchant_id = $1 AND s.sale_date >= $2::date AND s.sale_date <= $3::date
        GROUP BY p.name
        ORDER BY revenue DESC
        LIMIT ${TOP_N}`,
      [userId, w.fromDate, w.toDate]
    ),
  ]);

  return {
    summary: { revenue: round2(cur.revenue), orders: +cur.orders, customers: +cur.customers },
    previous: prev && { revenue: round2(prev.revenue), orders: +prev.orders, customers: +prev.customers },
    daily: daily.rows.map((r) => ({ date: r.day, revenue: round2(r.revenue), orders: +r.orders })),
    topProducts: top.rows.map((r) => ({ name: r.name, units: +r.units || 0, revenue: round2(r.revenue) })),
  };
}

// The window: the last `days` local calendar days (today included) and the
// same number of days before it. Clamped to the plan's data history; when the
// previous period would reach past it, there is no comparison (`previous` is null).
function windowFor(days, tz, limits) {
  const toDate = localDate(new Date(), tz);
  let fromDate = addDays(toDate, -(days - 1));
  const earliest = historyStart(limits);
  let clamped = false;
  if (earliest) {
    const earliestDate = earliest.toISOString().slice(0, 10);
    if (fromDate < earliestDate) {
      fromDate = earliestDate;
      clamped = true;
    }
  }
  const length = Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 864e5) + 1;
  const prevFromDate = addDays(fromDate, -length);
  return {
    tz,
    compare: !earliest || prevFromDate >= earliest.toISOString().slice(0, 10),
    days: length,
    clamped,
    fromDate,
    toDate,
    prevFromDate,
    start: dayRange(fromDate, tz).start,
    end: dayRange(toDate, tz).end,
    prevStart: dayRange(prevFromDate, tz).start,
  };
}

const LABELS = { square: "Square", shopify: "Shopify", ims: "IMS" };

// GET /api/unified/overview?days=7|30|90&tz=America/Denver
router.get("/overview", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const days = DAY_OPTIONS.includes(+req.query.days) ? +req.query.days : 30;
    const tz = isValidTimeZone(req.query.tz) ? req.query.tz : "UTC";
    const { limits } = await planFor(pool, userId);
    const w = windowFor(days, tz, limits);
    const has = await sourcesFor(userId);

    const jobs = [];
    if (has.square) jobs.push(["square", squareData(userId, w)]);
    if (has.shops.length) jobs.push(["shopify", shopifyData(has.shops, w)]);
    if (has.ims) jobs.push(["ims", imsData(userId, w)]);

    // A source that fails is reported as such; the others still show
    const settled = await Promise.allSettled(jobs.map((j) => j[1]));
    const sources = jobs.map(([key], i) => {
      const r = settled[i];
      if (r.status === "rejected") {
        console.error(`Unified ${key} error:`, r.reason && r.reason.message);
        return { key, name: LABELS[key], ok: false, error: `Couldn't load ${LABELS[key]} right now.` };
      }
      return { key, name: LABELS[key], ok: true, ...r.value };
    });

    return res.json({
      success: true,
      range: { from: w.fromDate, to: w.toDate, days: w.days, previousFrom: w.compare ? w.prevFromDate : null, timeZone: tz, clamped: w.clamped },
      sources,
    });
  } catch (err) {
    console.error("Unified overview error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
