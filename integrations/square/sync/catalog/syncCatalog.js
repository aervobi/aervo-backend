const { pool } = require('../../../../db');

async function syncCatalog({ client, merchantId }) {
  let cursor = null;
  let totalSynced = 0;

  do {
    const response = await client.catalogApi.listCatalog(cursor, 'ITEM,CATEGORY,ITEM_VARIATION');
    if (response.result.errors?.length) {
      throw new Error(`Square listCatalog error: ${JSON.stringify(response.result.errors)}`);
    }

    const objects = response.result.objects || [];
    cursor = response.result.cursor || null;

    if (objects.length) {
      await upsertCatalogObjects(objects, merchantId);
      totalSynced += objects.length;
    }
  } while (cursor);

  console.log(`Catalog sync complete: ${totalSynced} objects`);
  return totalSynced;
}

async function upsertCatalogObjects(objects, merchantId) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    for (const obj of objects) {
      if (obj.isDeleted) {
        await dbClient.query(
          `UPDATE square_catalog_items SET is_deleted=TRUE, updated_at=NOW() WHERE square_catalog_id=$1`,
          [obj.id]
        );
        continue;
      }

      let name = null, description = null, basePrice = null, categoryId = null;

      if (obj.type === 'ITEM') {
        const d = obj.itemData || {};
        name = d.name; description = d.description || null;
        categoryId = d.categoryId || null;
        basePrice = d.variations?.[0]?.itemVariationData?.priceMoney?.amount || null;
      } else if (obj.type === 'CATEGORY') {
        name = obj.categoryData?.name;
      } else if (obj.type === 'ITEM_VARIATION') {
        name = obj.itemVariationData?.name;
        basePrice = obj.itemVariationData?.priceMoney?.amount || null;
      }

      await dbClient.query(
        `INSERT INTO square_catalog_items
           (square_catalog_id, aervo_merchant_id, type, name, description,
            base_price_cents, category_id, is_deleted, updated_at, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
         ON CONFLICT (square_catalog_id) DO UPDATE SET
           name=EXCLUDED.name, description=EXCLUDED.description,
           base_price_cents=EXCLUDED.base_price_cents, is_deleted=EXCLUDED.is_deleted,
           updated_at=NOW(), raw_data=EXCLUDED.raw_data`,
        [obj.id, merchantId, obj.type, name, description, basePrice, categoryId, false, JSON.stringify(obj)]
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

module.exports = { syncCatalog, upsertCatalogObjects };