const { pool } = require('../../../../db');

async function syncCustomers({ client, merchantId }) {
  let cursor = null;
  let totalSynced = 0;

  do {
    const response = await client.customersApi.listCustomers(cursor, 100, 'CREATED_AT', 'ASC');
    if (response.result.errors?.length) {
      throw new Error(`Square listCustomers error: ${JSON.stringify(response.result.errors)}`);
    }

    const customers = response.result.customers || [];
    cursor = response.result.cursor || null;

    if (customers.length) {
      await upsertCustomers(customers, merchantId);
      totalSynced += customers.length;
    }
  } while (cursor);

  console.log(`Customers sync complete: ${totalSynced} customers`);
  return totalSynced;
}

async function upsertCustomers(customers, merchantId) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    for (const c of customers) {
      await dbClient.query(
        `INSERT INTO square_customers
           (square_customer_id, aervo_merchant_id, given_name, family_name,
            email_address, phone_number, birthday, address, note,
            reference_id, creation_source, created_at, updated_at,
            total_visit_count, aervo_segment, aervo_ltv_cents, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (square_customer_id) DO UPDATE SET
           given_name=EXCLUDED.given_name, family_name=EXCLUDED.family_name,
           email_address=EXCLUDED.email_address, phone_number=EXCLUDED.phone_number,
           note=EXCLUDED.note, updated_at=EXCLUDED.updated_at, raw_data=EXCLUDED.raw_data`,
        [
          c.id, merchantId, c.givenName || null, c.familyName || null,
          c.emailAddress || null, c.phoneNumber || null, c.birthday || null,
          c.address ? JSON.stringify(c.address) : null, c.note || null,
          c.referenceId || null, c.creationSource || null,
          c.createdAt, c.updatedAt, null, null, null, JSON.stringify(c),
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

module.exports = { syncCustomers, upsertCustomers };