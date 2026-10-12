// ============================================================
// Aervo QuickBooks Integration — Nightly Sync
// File: scripts/sync-quickbooks.js
// Usage: node scripts/sync-quickbooks.js (manual run)
// Also required by index.js, which schedules syncAll() nightly via
// node-cron — see the cron job registered near the other route mounts.
//
// For every Aervo user with a QuickBooks connection: refreshes the
// OAuth token if expired, then pulls Items, Purchases/Bills, and a
// P&L summary into the quickbooks_items / quickbooks_purchases /
// quickbooks_pnl_snapshots staging tables. Doesn't touch aervo_products
// directly — auto-matching (product_cost_mappings) is a separate step.
// See quickbooks-integration-spec.md section 2.
// ============================================================

require('dotenv').config();
const axios = require('axios');
const { pool } = require('../db');
const tokenStore = require('../routes/quickbooks/tokenStore');
const { autoMatchProducts } = require('../routes/products/costMapping');
const { calculateMargins } = require('../routes/analytics/margin');

const PURCHASE_LOOKBACK_DAYS = 180;
const PNL_LOOKBACK_DAYS = 90;
const PAGE_SIZE = 200;

function apiBase(environment) {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function qboDate(date) {
  return date.toISOString().slice(0, 10);
}

async function qbQuery(conn, query) {
  const res = await axios.get(`${apiBase(conn.environment)}/v3/company/${conn.realmId}/query`, {
    params: { query },
    headers: { Authorization: `Bearer ${conn.accessToken}`, Accept: 'application/json' },
  });
  return res.data;
}

async function qbReport(conn, reportName, params) {
  const res = await axios.get(
    `${apiBase(conn.environment)}/v3/company/${conn.realmId}/reports/${reportName}`,
    {
      params,
      headers: { Authorization: `Bearer ${conn.accessToken}`, Accept: 'application/json' },
    }
  );
  return res.data;
}

// Pages through a QBO entity query (SELECT * FROM <Entity> ...),
// returning every row across all pages.
async function queryAll(conn, entity, whereClause = '') {
  let startPosition = 1;
  let rows = [];

  while (true) {
    const query = `SELECT * FROM ${entity}${whereClause ? ` WHERE ${whereClause}` : ''} STARTPOSITION ${startPosition} MAXRESULTS ${PAGE_SIZE}`;
    const data = await qbQuery(conn, query);
    const page = data.QueryResponse?.[entity] || [];
    rows = rows.concat(page);
    if (page.length < PAGE_SIZE) break;
    startPosition += PAGE_SIZE;
  }

  return rows;
}

async function syncItems(conn) {
  const items = await queryAll(conn, 'Item');

  for (const item of items) {
    await pool.query(
      `INSERT INTO quickbooks_items
         (user_id, quickbooks_item_id, name, sku, type, unit_price, purchase_cost, raw_data, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (user_id, quickbooks_item_id) DO UPDATE SET
         name          = EXCLUDED.name,
         sku           = EXCLUDED.sku,
         type          = EXCLUDED.type,
         unit_price    = EXCLUDED.unit_price,
         purchase_cost = EXCLUDED.purchase_cost,
         raw_data      = EXCLUDED.raw_data,
         synced_at     = NOW()`,
      [
        conn.userId,
        item.Id,
        item.Name,
        item.Sku || null,
        item.Type || null,
        item.UnitPrice ?? null,
        item.PurchaseCost ?? null,
        JSON.stringify(item),
      ]
    );
  }

  return items.length;
}

// Pulls out the item-referencing lines from a Purchase or Bill —
// account-based expense lines (no ItemRef) aren't useful for per-item
// cost and are skipped.
function extractItemLines(txn) {
  const lines = txn.Line || [];
  const itemLines = [];

  lines.forEach((line, idx) => {
    if (line.DetailType !== 'ItemBasedExpenseLineDetail') return;
    const detail = line.ItemBasedExpenseLineDetail || {};
    if (!detail.ItemRef?.value) return;

    itemLines.push({
      lineId: line.Id != null ? String(line.Id) : String(idx),
      quickbooksItemId: detail.ItemRef.value,
      quantity: detail.Qty ?? null,
      unitCost: detail.UnitPrice ?? null,
      amount: line.Amount,
      rawData: line,
    });
  });

  return itemLines;
}

async function syncPurchaseLikeEntity(conn, entity, transactionType, sinceDate) {
  const whereClause = `TxnDate >= '${qboDate(sinceDate)}'`;
  const transactions = await queryAll(conn, entity, whereClause);
  let lineCount = 0;

  for (const txn of transactions) {
    const itemLines = extractItemLines(txn);

    for (const line of itemLines) {
      await pool.query(
        `INSERT INTO quickbooks_purchases
           (user_id, transaction_type, quickbooks_transaction_id, line_id,
            quickbooks_item_id, txn_date, quantity, unit_cost, amount, raw_data, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (user_id, transaction_type, quickbooks_transaction_id, line_id) DO UPDATE SET
           quickbooks_item_id = EXCLUDED.quickbooks_item_id,
           txn_date           = EXCLUDED.txn_date,
           quantity           = EXCLUDED.quantity,
           unit_cost          = EXCLUDED.unit_cost,
           amount             = EXCLUDED.amount,
           raw_data           = EXCLUDED.raw_data,
           synced_at          = NOW()`,
        [
          conn.userId,
          transactionType,
          txn.Id,
          line.lineId,
          line.quickbooksItemId,
          txn.TxnDate || null,
          line.quantity,
          line.unitCost,
          line.amount,
          JSON.stringify(line.rawData),
        ]
      );
      lineCount++;
    }
  }

  return { transactionCount: transactions.length, lineCount };
}

async function syncPnl(conn) {
  const endDate = new Date();
  const startDate = new Date(Date.now() - PNL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const report = await qbReport(conn, 'ProfitAndLoss', {
    start_date: qboDate(startDate),
    end_date: qboDate(endDate),
    summarize_column_by: 'Total',
  });

  await pool.query(
    `INSERT INTO quickbooks_pnl_snapshots (user_id, period_start, period_end, data, synced_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, period_start, period_end) DO UPDATE SET
       data      = EXCLUDED.data,
       synced_at = NOW()`,
    [conn.userId, qboDate(startDate), qboDate(endDate), JSON.stringify(report)]
  );

  return { periodStart: qboDate(startDate), periodEnd: qboDate(endDate) };
}

async function syncUser(userId) {
  console.log(`--- Syncing QuickBooks for user ${userId} ---`);
  const conn = await tokenStore.getValidConnection(userId);
  if (!conn) {
    console.warn(`No QuickBooks connection for user ${userId}, skipping`);
    return;
  }

  const sinceDate = new Date(Date.now() - PURCHASE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const itemCount = await syncItems(conn);
  console.log(`  Items synced: ${itemCount}`);

  const matchResult = await autoMatchProducts(pool, userId);
  console.log(`  Auto-match: ${matchResult.autoMatched} matched, ${matchResult.created} unmatched rows created (${matchResult.productCount} products)`);

  const purchases = await syncPurchaseLikeEntity(conn, 'Purchase', 'purchase', sinceDate);
  console.log(`  Purchases synced: ${purchases.transactionCount} txns, ${purchases.lineCount} item lines`);

  const bills = await syncPurchaseLikeEntity(conn, 'Bill', 'bill', sinceDate);
  console.log(`  Bills synced: ${bills.transactionCount} txns, ${bills.lineCount} item lines`);

  const pnl = await syncPnl(conn);
  console.log(`  P&L snapshot synced: ${pnl.periodStart} to ${pnl.periodEnd}`);

  const margin = await calculateMargins(pool, userId);
  console.log(`  Margin snapshot computed: ${margin.productCount} product(s) for week of ${margin.periodStart.toISOString().slice(0, 10)}`);
}

async function syncAll() {
  const userIds = await tokenStore.getAllConnectedUserIds();
  console.log(`Found ${userIds.length} connected QuickBooks user(s)`);

  for (const userId of userIds) {
    try {
      await syncUser(userId);
      await tokenStore.markSyncStatus(userId, 'success');
    } catch (err) {
      console.error(`QuickBooks sync failed for user ${userId}:`, err.response?.data || err.message);
      await tokenStore.markSyncStatus(userId, 'error', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    }
  }

  console.log('QuickBooks sync complete');
}

// Only self-execute (and exit the process) when run directly via
// `node scripts/sync-quickbooks.js` — index.js requires syncAll() to
// run it on a schedule inside the long-lived server process, where
// calling process.exit() would kill the whole web service.
if (require.main === module) {
  syncAll()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal error in QuickBooks sync:', err.message);
      process.exit(1);
    });
}

module.exports = { syncAll };
