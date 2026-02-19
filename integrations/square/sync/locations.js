const { pool } = require('../../../db');

async function syncLocations({ client, merchantId }) {
  const response = await client.locationsApi.listLocations();

  if (response.result.errors?.length) {
    throw new Error(`Square listLocations error: ${JSON.stringify(response.result.errors)}`);
  }

  const activeLocations = (response.result.locations || []).filter(l => l.status === 'ACTIVE');
  const upserted = [];

  for (const loc of activeLocations) {
    await pool.query(
      `INSERT INTO square_locations
         (aervo_merchant_id, square_location_id, name, address, city, state,
          postal_code, country, timezone, business_type, phone_number,
          business_hours, currency, raw_data, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (square_location_id) DO UPDATE SET
         name=EXCLUDED.name, address=EXCLUDED.address, city=EXCLUDED.city,
         state=EXCLUDED.state, timezone=EXCLUDED.timezone,
         business_hours=EXCLUDED.business_hours, raw_data=EXCLUDED.raw_data,
         updated_at=NOW()`,
      [
        merchantId, loc.id, loc.name,
        loc.address?.addressLine1 || null,
        loc.address?.locality || null,
        loc.address?.administrativeDistrictLevel1 || null,
        loc.address?.postalCode || null,
        loc.address?.country || null,
        loc.timezone || null, loc.type || null,
        loc.phoneNumber || null,
        JSON.stringify(loc.businessHours || {}),
        loc.currency || 'USD',
        JSON.stringify(loc),
      ]
    );
    upserted.push({ squareLocationId: loc.id, name: loc.name });
  }

  return upserted;
}

async function getMerchantLocations(merchantId) {
  const result = await pool.query(
    `SELECT square_location_id, name, city, state, timezone, business_type
     FROM square_locations WHERE aervo_merchant_id = $1 ORDER BY name`,
    [merchantId]
  );
  return result.rows;
}

module.exports = { syncLocations, getMerchantLocations };