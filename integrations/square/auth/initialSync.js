// integrations/square/sync/initialSync.js
// Orchestrates the full historical data pull when a merchant first connects.
// Runs all four sync modules in the correct dependency order.
//
// Order matters:
//   1. Locations   (needed to scope all other queries)
//   2. Catalog     (products/menu items — needed to enrich orders)
//   3. Customers   (needed to link orders to people)
//   4. Orders      (transactions — the core revenue data)
//   5. Appointments (if the merchant uses Square Appointments)

const { syncLocations } = require('./locations');
const { syncOrders } = require('./orders/syncOrders');
const { syncCustomers } = require('./customers/syncCustomers');
const { syncCatalog } = require('./catalog/syncCatalog');
const { syncAppointments } = require('./appointments/syncAppointments');
const { buildSquareClient } = require('../client');
const logger = require('../../../lib/logger');

// How far back to pull historical data on first connect
const INITIAL_LOOKBACK_DAYS = 365;

/**
 * Run the full initial sync for a newly connected merchant.
 * Called in the background after OAuth completes.
 *
 * @param {object} params
 * @param {string} params.merchantId       - Aervo merchant ID
 * @param {string} params.squareMerchantId - Square merchant ID
 * @param {string} params.accessToken      - Square OAuth access token
 */
async function startInitialSync({ merchantId, squareMerchantId, accessToken }) {
  const client = buildSquareClient(accessToken);
  const startTime = Date.now();

  logger.info('Starting Square initial sync', {
    merchantId,
    squareMerchantId,
    lookbackDays: INITIAL_LOOKBACK_DAYS,
  });

  const beginDate = new Date();
  beginDate.setDate(beginDate.getDate() - INITIAL_LOOKBACK_DAYS);
  const startAt = beginDate.toISOString();

  try {
    // ── Step 1: Locations ─────────────────────────────────────────────────────
    // Must come first — all other syncs filter by location
    logger.info('Syncing locations...', { merchantId });
    const locations = await syncLocations({ client, merchantId });
    const locationIds = locations.map((l) => l.squareLocationId);
    logger.info(`Found ${locationIds.length} location(s)`, { merchantId });

    // ── Step 2: Catalog ───────────────────────────────────────────────────────
    logger.info('Syncing catalog/menu...', { merchantId });
    await syncCatalog({ client, merchantId });

    // ── Step 3: Customers ─────────────────────────────────────────────────────
    logger.info('Syncing customers...', { merchantId });
    await syncCustomers({ client, merchantId });

    // ── Step 4: Orders (per location) ─────────────────────────────────────────
    // Run locations in parallel for speed
    logger.info('Syncing orders...', { merchantId });
    await Promise.all(
      locationIds.map((locationId) =>
        syncOrders({ client, merchantId, locationId, startAt })
      )
    );

    // ── Step 5: Appointments ──────────────────────────────────────────────────
    logger.info('Syncing appointments...', { merchantId });
    await Promise.all(
      locationIds.map((locationId) =>
        syncAppointments({ client, merchantId, locationId, startAt })
      )
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Square initial sync complete in ${elapsed}s`, { merchantId });

    // Mark sync as complete in DB
    await markSyncComplete(merchantId, 'success');
  } catch (err) {
    logger.error('Square initial sync failed', { merchantId, error: err.message });
    await markSyncComplete(merchantId, 'error', err.message);
    throw err;
  }
}

async function markSyncComplete(merchantId, status, errorMessage = null) {
  const { pool } = require('../../../lib/db');
  await pool.query(
    `UPDATE square_connections
     SET sync_status = $1, sync_completed_at = NOW(), sync_error = $2
     WHERE aervo_merchant_id = $3`,
    [status, errorMessage, merchantId]
  );
}

module.exports = { startInitialSync };
