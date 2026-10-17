const { pool } = require('../../../../db');
const { collectPages, jsonSafe } = require('../../util');

const WINDOW_DAYS = 30; // Square's ListBookings accepts at most 31 days per request
const FUTURE_DAYS = 90; // also bring in upcoming appointments

async function syncAppointments({ client, merchantId, locationId, startAt }) {
  let totalSynced = 0;
  const end = Date.now() + FUTURE_DAYS * 86400000;

  try {
    for (let from = new Date(startAt).getTime(); from < end; from += WINDOW_DAYS * 86400000) {
      const to = Math.min(from + WINDOW_DAYS * 86400000, end);
      const bookings = await collectPages(
        client.bookings.list({
          limit: 100,
          locationId,
          startAtMin: new Date(from).toISOString(),
          startAtMax: new Date(to).toISOString(),
        })
      );
      if (bookings.length) {
        await upsertAppointments(bookings, merchantId, locationId);
        totalSynced += bookings.length;
      }
    }
  } catch (err) {
    // Sellers without Square Appointments (most retail) get a permission error here
    console.log('Square Appointments unavailable - skipping', { status: err.statusCode, error: err.message });
    return totalSynced;
  }

  console.log('Appointments sync complete: ' + totalSynced + ' bookings');
  return totalSynced;
}

async function upsertAppointments(bookings, merchantId, locationId) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    for (const b of bookings) {
      const seg = b.appointmentSegments?.[0] || {};
      await dbClient.query(
        'INSERT INTO square_appointments (square_booking_id, aervo_merchant_id, square_location_id, square_customer_id, customer_note, team_member_id, service_variation_id, service_variation_version, duration_minutes, status, start_at, created_at, updated_at, source, no_show, raw_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (square_booking_id) DO UPDATE SET status=EXCLUDED.status, start_at=EXCLUDED.start_at, no_show=EXCLUDED.no_show, updated_at=EXCLUDED.updated_at, raw_data=EXCLUDED.raw_data',
        [b.id, merchantId, locationId, b.customerId || null, b.customerNote || null, seg.teamMemberId || null, seg.serviceVariationId || null, seg.serviceVariationVersion || null, seg.durationMinutes || null, b.status, b.startAt, b.createdAt, b.updatedAt, b.source || 'FIRST_PARTY_MERCHANT', b.status === 'NO_SHOW', jsonSafe(b)]
      );
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
}

module.exports = { syncAppointments, upsertAppointments };
