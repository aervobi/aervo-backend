const { pool } = require('../../../../db');

async function syncOrders({ client, merchantId, locationId, startAt }) {
  let cursor = null;
  let totalSynced = 0;

  do {
    const body = {
      locationIds: [locationId],
      query: {
        filter: {
          dateTimeFilter: { createdAt: { startAt } },
          stateFilter: { states: ['COMPLETED', 'CANCELED'] },
        },
        sort: { sortField: 'CREATED_AT', sortOrder: 'ASC' },
      },
      limit: 500,
      returnEntries: false,
    };
    if (cursor) body.cursor = cursor;

    const response = await client.ordersApi.searchOrders(body);
    if (response.result.errors?.length) {
      throw new Error(`Square searchOrders error: ${JSON.stringify(response.result.errors)}`);
    }

    const orders = response.result.orders || [];
    cursor = response.result.cursor || null;

    if (orders.length) {
      await upsertOrders(orders, merchantId, locationId);
      totalSynced += orders.length;
    }
  } while (cursor);

  console.log(`Orders sync complete: ${totalSynced} orders for location ${locationId}`);
  return totalSynced;
}

async function upsertOrders(orders, merchantId, locationId) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    for (const order of orders) {
      await dbClient.query(
        `INSERT INTO square_orders
           (square_order_id, aervo_merchant_id, square_location_id, square_customer_id,
            state, total_amount, total_tax, total_discount, currency, source_name,
            created_at, updated_at, closed_at, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (square_order_id) DO UPDATE SET
           state=EXCLUDED.state, total_amount=EXCLUDED.total_amount,
           closed_at=EXCLUDED.closed_at, raw_data=EXCLUDED.raw_data, updated_at=NOW()`,
        [
          order.id, merchantId, locationId, order.customerId || null, order.state,
          order.totalMoney?.amount || 0, order.totalTaxMoney?.amount || 0,
          order.totalDiscountMoney?.amount || 0, order.totalMoney?.currency || 'USD',
          order.source?.name || 'POS', order.createdAt, order.updatedAt,
          order.closedAt || null, JSON.stringify(order),
        ]
      );

      await dbClient.query(`DELETE FROM square_order_line_items WHERE square_order_id = $1`, [order.id]);

      for (const item of order.lineItems || []) {
        await dbClient.query(
          `INSERT INTO square_order_line_items
             (square_order_id, aervo_merchant_id, catalog_object_id, name,
              quantity, base_price, gross_amount, variation_name, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            order.id, merchantId, item.catalogObjectId || null, item.name,
            parseFloat(item.quantity), item.basePriceMoney?.amount || 0,
            item.grossSalesMoney?.amount || 0, item.variationName || null, item.note || null,
          ]
        );
      }
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
}

module.exports = { syncOrders, upsertOrders };