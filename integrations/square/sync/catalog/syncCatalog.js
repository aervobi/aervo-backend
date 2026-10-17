const { pool } = require('../../../../db');
const { collectPages, jsonSafe, cents } = require('../../util');

async function syncCatalog({ client, merchantId }) {
  const objects = await collectPages(client.catalog.list({ types: 'ITEM,CATEGORY,ITEM_VARIATION' }));
  for (let i = 0; i < objects.length; i += 500) {
    await upsertCatalogObjects(objects.slice(i, i + 500), merchantId);
  }
  console.log(`Catalog sync complete: ${objects.length} objects`);
  return objects.length;
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
        const p = d.variations?.[0]?.itemVariationData?.priceMoney?.amount;
        basePrice = p == null ? null : cents(p);
      } else if (obj.type === 'CATEGORY') {
        name = obj.categoryData?.name;
      } else if (obj.type === 'ITEM_VARIATION') {
        name = obj.itemVariationData?.name;
        const p = obj.itemVariationData?.priceMoney?.amount;
        basePrice = p == null ? null : cents(p);
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
        [obj.id, merchantId, obj.type, name, description, basePrice, categoryId, false, jsonSafe(obj)]
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
