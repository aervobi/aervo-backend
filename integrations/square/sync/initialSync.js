// integrations/square/sync/initialSync.js
const { syncLocations } = require('./locations');
const { syncOrders } = require('./orders/syncOrders');
const { syncCustomers } = require('./customers/syncCustomers');
const { syncCatalog } = require('./catalog/syncCatalog');
const { syncAppointments } = require('./appointments/syncAppointments');
const { buildSquareClient } = require('../client');
const { pool } = require('../../../db');

const INITIAL_LOOKBACK_DAYS = 365;

async function startInitialSync({ merchantId, squareMerchantId, accessToken }) {
  const client = buildSquareClient(accessToken);
  const startTime = Date.now();

  console.log('Starting Square initial sync', { merchantId, squareMerchantId });

  const beginDate = new Date();
  beginDate.setDate(beginDate.getDate() - INITIAL_LOOKBACK_DAYS);
  const startAt = beginDate.toISOString();

  try {
    console.log('Syncing locations...');
    const locations = await syncLocations({ client, merchantId });
    const locationIds = locations.map((l) => l.squareLocationId);
    console.log(`Found ${locationIds.length} location(s)`);

    console.log('Syncing catalog/menu...');
    await syncCatalog({ client, merchantId });

    console.log('Syncing customers...');
    await syncCustomers({ client, merchantId });

    console.log('Syncing orders...');
    await Promise.all(
      locationIds.map((locationId) =>
        syncOrders({ client, merchantId, locationId, startAt })
      )
    );

    console.log('Syncing appointments...');
    await Promise.all(
      locationIds.map((locationId) =>
        syncAppointments({ client, merchantId, locationId, startAt })
      )
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Square initial sync complete in ${elapsed}s`);

    await markSyncComplete(merchantId, 'success');
  } catch (err) {
    console.error('Square initial sync failed:', err.message);
    await markSyncComplete(merchantId, 'error', err.message);
    throw err;
  }
}

async function markSyncComplete(merchantId, status, errorMessage = null) {
  await pool.query(
    `UPDATE square_connections
     SET sync_status = $1, sync_completed_at = NOW(), sync_error = $2
     WHERE aervo_merchant_id = $3`,
    [status, errorMessage, merchantId]
  );
}

module.exports = { startInitialSync };