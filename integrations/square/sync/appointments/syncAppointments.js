const { pool } = require('../../../../db');

async function syncAppointments({ client, merchantId, locationId, startAt }) {
  let cursor = null;
  let totalSynced = 0;

  do {
    const response = await client.bookingsApi.listBookings(100, cursor, null, locationId, startAt);

    if (response.result.errors?.length) {
      const notEnabled = response.result.errors.some(
        e => e.code === 'SERVICE_UNAVAILABLE' || e.category === 'INVALID_REQUEST_ERROR'
      );
      if (notEnabled) {
        console.log(`Square Appointments not enabled for merchant ${merchantId}`);
        return 0;
      }
      throw new Error(`Square listBookings error: ${JSON.stringify(response.result.errors)}`);
    }

    const bookings = response.result.bookings || [];
    cursor = response.result.cursor || null;

    if (bookings.length) {
      await upsertAppointments(bookings, merchantId, locationId);
      totalSynced += bookings.length;
    }
  } while (cursor);

  console.log(`Appointments sync complete: ${totalSynced} bookings`);
  return totalSynced;
}

async function upsertAppointments(bookings, merchantId, locationId) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    for (const b of bookings) {
      const seg = b.appointmentSegments?.[0] || {};
      await dbClient.query(
        `INSERT INTO square_appointments
           (square_booking_id, aervo_merchant_id, square_location_id, square_customer_id,
            customer_note, team_member_id, service_variation_id, service_variation_version,
            duration_minutes, status, start_at, created_at, updated_at, source, no_show, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (square_booking_id) DO UPDATE SET
           status=EXCLUDED.status, start_at=EXCLUDED.start_at,
           no_show=EXCLUDED.no_show, updated_at=EXCLUDED.updated_at, raw_data=EXCLUDED.raw_data`,
        [
          b.id, merchantId, locationId, b.customerId || null, b.customerNote || null,
          seg.teamMemberId || null, seg.serviceVariationId || null,
          seg.serviceVariationVersion || null, seg.durationMinutes || null,
          b.status, b.startAt, b.createdAt, b.updatedAt,
          b.source || 'FIRST_PARTY_MERCHANT', b.status === 'NO_SHOW', JSON.stringify(b),
        ]
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