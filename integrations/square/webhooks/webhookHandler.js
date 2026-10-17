// integrations/square/webhooks/webhookHandler.js
const crypto = require('crypto');
const { upsertOrders } = require('../sync/orders/syncOrders');
const { upsertCustomers } = require('../sync/customers/syncCustomers');
const { upsertAppointments } = require('../sync/appointments/syncAppointments');
const { syncCatalog } = require('../sync/catalog/syncCatalog');
const { deleteTokens } = require('../auth/tokenStore');
const { getValidAccessToken } = require('../auth/oauth');
const { buildSquareClient } = require('../client');
const { camelize, cents, jsonSafe } = require('../util');
const { pool } = require('../../../db');

// Tables only webhooks write to. Created here so a fresh database works.
let extraTables;
function ensureWebhookTables() {
  if (!extraTables) {
    extraTables = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS square_payments (
        square_payment_id TEXT PRIMARY KEY, aervo_merchant_id TEXT NOT NULL, square_order_id TEXT,
        square_customer_id TEXT, amount BIGINT, tip_amount BIGINT, currency TEXT, status TEXT,
        source_type TEXT, card_brand TEXT, location_id TEXT, created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ, raw_data JSONB)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS square_inventory (
        aervo_merchant_id TEXT NOT NULL, catalog_object_id TEXT NOT NULL, location_id TEXT NOT NULL,
        quantity NUMERIC, status TEXT, calculated_at TIMESTAMPTZ,
        PRIMARY KEY (aervo_merchant_id, catalog_object_id, location_id))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS square_team_members (
        square_team_member_id TEXT PRIMARY KEY, aervo_merchant_id TEXT NOT NULL, given_name TEXT,
        family_name TEXT, status TEXT, email_address TEXT, phone_number TEXT,
        created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, raw_data JSONB)`);
    })().catch((err) => {
      extraTables = null;
      console.error('Could not create Square webhook tables:', err.message);
    });
  }
  return extraTables;
}

function verifyWebhookSignature(body, signature, notificationUrl) {
  const signingKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!signingKey) {
    // Fail closed: without the key anyone could post fake events for any merchant.
    console.error('SQUARE_WEBHOOK_SIGNATURE_KEY not set - rejecting webhook');
    return false;
  }
  if (!signature || typeof body !== 'string') return false;
  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(notificationUrl + body)
    .digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleWebhookEvent(req, res) {
  const signature = req.headers['x-square-hmacsha256-signature'];
  const rawBody = req.rawBody;
  // Must match, character for character, the notification URL registered for the
  // webhook subscription in the Square developer dashboard.
  const notificationUrl = `${process.env.AERVO_APP_URL || 'https://api.aervoapp.com'}/integrations/square/webhooks`;

  if (!verifyWebhookSignature(rawBody, signature, notificationUrl)) {
    console.warn('Square webhook signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // The raw-body middleware switches the content type to text/plain so the JSON
  // parser skips this route, which leaves req.body empty. Parse the verified body.
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  res.status(200).json({ received: true });

  processEvent(event).catch((err) =>
    console.error('Webhook processing failed', { error: err.message, event: event?.type })
  );
}

async function processEvent(event) {
  const { type, merchant_id: squareMerchantId } = event;
  // Square sends snake_case JSON; our upserts (like the SDK) use camelCase
  const data = camelize(event.data || {});
  console.log('Processing Square webhook:', type);

  const aervMerchantId = await aervoIdForSquareMerchant(squareMerchantId);
  if (!aervMerchantId) {
    console.warn('Received webhook for unknown Square merchant', { squareMerchantId });
    return;
  }

  // The seller removed Aervo in their Square dashboard: forget the tokens
  if (type === 'oauth.authorization.revoked') {
    await deleteTokens(aervMerchantId);
    console.log('Square access revoked by seller; tokens removed', { aervMerchantId });
    return;
  }

  await ensureWebhookTables();
  let client = null;
  const squareClient = async () => {
    if (!client) {
      const token = await getValidAccessToken(aervMerchantId);
      if (!token) throw new Error('No Square token for merchant');
      client = buildSquareClient(token);
    }
    return client;
  };

  switch (type) {

    // ── Orders ────────────────────────────────────────────────────────────────
    case 'order.created':
    case 'order.updated':
    case 'order.fulfillment.updated': {
      const o = data.object || {};
      const orderId = o.orderCreated?.orderId || o.orderUpdated?.orderId || o.orderFulfillmentUpdated?.orderId || data.id;
      if (orderId) await syncSingleOrder(await squareClient(), aervMerchantId, orderId);
      break;
    }

    // ── Payments ──────────────────────────────────────────────────────────────
    case 'payment.created':
    case 'payment.updated': {
      const payment = data.object?.payment;
      if (payment) await upsertPayment(payment, aervMerchantId);
      if (payment?.orderId) await syncSingleOrder(await squareClient(), aervMerchantId, payment.orderId);
      break;
    }

    // ── Customers ─────────────────────────────────────────────────────────────
    case 'customer.created':
    case 'customer.updated': {
      const customer = data.object?.customer;
      if (customer) await upsertCustomers([customer], aervMerchantId);
      break;
    }
    case 'customer.deleted': {
      const customerId = data.object?.customer?.id || data.id;
      if (customerId) await softDeleteCustomer(aervMerchantId, customerId);
      break;
    }

    // ── Appointments ──────────────────────────────────────────────────────────
    case 'booking.created':
    case 'booking.updated': {
      const booking = data.object?.booking;
      if (booking) await upsertAppointments([booking], aervMerchantId, booking.locationId);
      break;
    }
    case 'booking.cancelled': {
      const booking = data.object?.booking;
      if (booking) await upsertAppointments([{ ...booking, status: 'CANCELLED' }], aervMerchantId, booking.locationId);
      break;
    }

    // ── Catalog / Menu ────────────────────────────────────────────────────────
    case 'catalog.version.updated': {
      console.log('Catalog updated, triggering re-sync', { aervMerchantId });
      await syncCatalog({ client: await squareClient(), merchantId: aervMerchantId });
      break;
    }

    // ── Inventory ─────────────────────────────────────────────────────────────
    case 'inventory.count.updated': {
      const counts = data.object?.inventoryCounts || data.object?.counts || [];
      if (counts.length) await upsertInventoryCounts(counts, aervMerchantId);
      break;
    }

    // ── Team Members / Staff ──────────────────────────────────────────────────
    case 'team_member.created':
    case 'team_member.updated': {
      const teamMember = data.object?.teamMember;
      if (teamMember) await upsertTeamMember(teamMember, aervMerchantId);
      break;
    }

    default:
      console.log('Unhandled Square webhook event type:', type);
  }
}

async function syncSingleOrder(client, merchantId, orderId) {
  const response = await client.orders.get({ orderId });
  if (response.order) {
    await upsertOrders([response.order], merchantId, response.order.locationId);
  }
}

async function softDeleteCustomer(merchantId, squareCustomerId) {
  await pool.query(
    `UPDATE square_customers SET is_deleted = TRUE, updated_at = NOW()
     WHERE aervo_merchant_id = $1 AND square_customer_id = $2`,
    [merchantId, squareCustomerId]
  );
}

async function upsertPayment(payment, merchantId) {
  await pool.query(
    `INSERT INTO square_payments
       (square_payment_id, aervo_merchant_id, square_order_id, square_customer_id,
        amount, tip_amount, currency, status, source_type, card_brand,
        location_id, created_at, updated_at, raw_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (square_payment_id) DO UPDATE SET
       status=EXCLUDED.status, updated_at=EXCLUDED.updated_at, raw_data=EXCLUDED.raw_data`,
    [
      payment.id, merchantId, payment.orderId || null, payment.customerId || null,
      cents(payment.amountMoney?.amount), cents(payment.tipMoney?.amount),
      payment.amountMoney?.currency || 'USD', payment.status,
      payment.sourceType || null,
      payment.cardDetails?.card?.cardBrand || null,
      payment.locationId || null,
      payment.createdAt, payment.updatedAt,
      jsonSafe(payment),
    ]
  ).catch(err => console.warn('Could not upsert payment:', err.message));
}

async function upsertInventoryCounts(counts, merchantId) {
  for (const count of counts) {
    await pool.query(
      `INSERT INTO square_inventory
         (aervo_merchant_id, catalog_object_id, location_id, quantity, status, calculated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (aervo_merchant_id, catalog_object_id, location_id) DO UPDATE SET
         quantity=EXCLUDED.quantity, status=EXCLUDED.status, calculated_at=EXCLUDED.calculated_at`,
      [
        merchantId, count.catalogObjectId, count.locationId,
        parseFloat(count.quantity || 0), count.state,
        count.calculatedAt || new Date().toISOString(),
      ]
    ).catch(err => console.warn('Could not upsert inventory count:', err.message));
  }
}

async function upsertTeamMember(member, merchantId) {
  await pool.query(
    `INSERT INTO square_team_members
       (square_team_member_id, aervo_merchant_id, given_name, family_name,
        status, email_address, phone_number, created_at, updated_at, raw_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (square_team_member_id) DO UPDATE SET
       given_name=EXCLUDED.given_name, family_name=EXCLUDED.family_name,
       status=EXCLUDED.status, updated_at=EXCLUDED.updated_at, raw_data=EXCLUDED.raw_data`,
    [
      member.id, merchantId, member.givenName || null, member.familyName || null,
      member.status || null, member.emailAddress || null, member.phoneNumber || null,
      member.createdAt, member.updatedAt, jsonSafe(member),
    ]
  ).catch(err => console.warn('Could not upsert team member:', err.message));
}

async function aervoIdForSquareMerchant(squareMerchantId) {
  if (!squareMerchantId) return null;
  const result = await pool.query(
    `SELECT aervo_merchant_id FROM square_connections WHERE square_merchant_id = $1`,
    [squareMerchantId]
  );
  return result.rows[0]?.aervo_merchant_id || null;
}

module.exports = { handleWebhookEvent, verifyWebhookSignature, processEvent };