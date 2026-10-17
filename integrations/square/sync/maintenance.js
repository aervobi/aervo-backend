// integrations/square/sync/maintenance.js
// Nightly job for every connected Square seller:
//  1. keep the access token fresh (Square tokens expire after 30 days; this
//     refreshes them a week early), and
//  2. catch up on orders changed in the last few days, in case a webhook was
//     missed (downtime, a deploy, Square retries giving up).
// A seller whose access was revoked is marked "reconnect_required" (shown on
// their dashboard) and skipped until they reconnect.
const { pool } = require('../../../db');
const { getValidAccessToken } = require('../auth/oauth');
const { buildSquareClient } = require('../client');
const { syncOrders } = require('./orders/syncOrders');

const CATCH_UP_DAYS = 3;

async function runSquareMaintenance({ pauseMs = 300 } = {}) {
  const stats = { checked: 0, refreshedOrValid: 0, reconnectRequired: 0, failed: 0, ordersSynced: 0 };
  const rows = (
    await pool.query(
      `SELECT aervo_merchant_id FROM square_connections
        WHERE COALESCE(sync_status, '') <> 'reconnect_required'`
    )
  ).rows;

  const since = new Date(Date.now() - CATCH_UP_DAYS * 86400000).toISOString();

  for (const { aervo_merchant_id: merchantId } of rows) {
    stats.checked++;
    try {
      const token = await getValidAccessToken(merchantId);
      if (!token) continue;
      stats.refreshedOrValid++;

      const client = buildSquareClient(token);
      const locations = (
        await pool.query(`SELECT square_location_id FROM square_locations WHERE aervo_merchant_id = $1`, [merchantId])
      ).rows;
      for (const { square_location_id: locationId } of locations) {
        stats.ordersSynced += await syncOrders({ client, merchantId, locationId, updatedSince: since });
      }
    } catch (err) {
      if (err.reconnectRequired) stats.reconnectRequired++;
      else stats.failed++;
      console.error('Square maintenance failed for merchant', { merchantId, error: err.message });
    }
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs)); // stay well under Square's rate limits
  }

  console.log('Square maintenance done', stats);
  return stats;
}

module.exports = { runSquareMaintenance, CATCH_UP_DAYS };
