// integrations/square/webhooks/webhookHandler.js
const crypto = require('crypto');
const { upsertOrders } = require('../sync/orders/syncOrders');
const { upsertCustomers } = require('../sync/customers/syncCustomers');
const { upsertAppointments } = require('../sync/appointments/syncAppointments');
const { syncCatalog } = require('../sync/catalog/syncCatalog');
const { getTokensByMerchant } = require('../auth/tokenStore');
const { buildSquareClient } = require('../client');
const { pool } = require('../../../db');

function verifyWebhookSignature(body, signature, notificationUrl) {
  const signingKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!signingKey) {
    console.warn('SQUARE_WEBHOOK_SIGNATURE_KEY not set — skipping signature verification');
    return true;
  }
  const payload = notificationUrl + body;
  const hmac = crypto.createHmac('sha256', signingKey);
  hmac.update(payload);
  const expected = hmac.digest('base64');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function handleWebhookEvent(req, res) {
  const signature = req.headers['x-square-hmacsha256-signature'];
  const rawBody = req.rawBody;
  const notificationUrl = `${process.env.AERVO_APP_URL}/integrations/square/webhooks`;

  if (!verifyWebhookSignature(rawBody, signature, notificationUrl)) {
    console.warn('Square webhook signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.status(200).json({ received: true });

  processEvent(req.body).catch((err) =>
    console.error('Webhook processing failed', { error: err.message, event: req.body?.type })
  );
}

async function processEvent(event) {
  const { type, merchant_id: squareMerchantId, data } = event;
  console.log('Processing Square webhook:', type);

  const tokens = await getTokensBySquareMerchant(squareMerchantId);
  if (!tokens) {
    console.warn('Received webhook for unknown Square merchant', { squareMerchantId });
    return;
  }

  const { aervMerchantId, accessToken } = tokens;
  const client = buildSquareClient(accessToken);

  switch (type) {

    // ── Orders ────────────────────────────────────────────────────────────────
    case 'order.created':
    case 'order.updated':
    case 'order.fulfillment.updated': {
      const orderId = data?.object?.order_created?.order_id ||
                      data?.object?.order_updated?.order_id ||
                      data?.id;
      if (orderId) await syncSingleOrder(client, aervMerchantId, orderId);
      break;
    }

    // ── Payments ──────────────────────────────────────────────────────────────
    case 'payment.created':
    case 'payment.updated': {
      const payment = data?.object?.payment;
      if (payment?.orderId) await syncSingleOrder(client, aervMerchantId, payment.orderId);
      if (payment) await upsertPayment(payment, aervMerchantId);
      break;
    }

    // ── Customers ─────────────────────────────────────────────────────────────
    case 'customer.created':
    case 'customer.updated': {
      const customer = data?.object?.customer;
      if (customer) await upsertCustomers([customer], aervMerchantId);
      break;
    }
    case 'customer.deleted': {
      const customerId = data?.object?.customer?.id;
      if (customerId) await softDeleteCustomer(aervMerchantId, customerId);
      break;
    }

    // ── Appointments ──────────────────────────────────────────────────────────
    case 'booking.created':
    case 'booking.updated': {
      const booking = data?.object?.booking;
      if (booking) await upsertAppointments([booking], aervMerchantId, booking.locationId);
      break;
    }
    case 'booking.cancelled': {
      const booking = data?.object?.booking;
      if (booking) await upsertAppointments([{ ...booking, status: 'CANCELLED' }], aervMerchantId, booking.locationId);
      break;
    }

    // ── Catalog / Menu ────────────────────────────────────────────────────────
    case 'catalog.version.updated': {
      console.log('Catalog updated, triggering re-sync', { aervMerchantId });
      await syncCatalog({ client, merchantId: aervMerchantId });
      break;
    }

    // ── Inventory ─────────────────────────────────────────────────────────────
    case 'inventory.count.updated': {
      const counts = data?.object?.counts || [];
      if (counts.length) await upsertInventoryCounts(counts, aervMerchantId);
      break;
    }

    // ── Team Members / Staff ──────────────────────────────────────────────────
    case 'team_member.created':
    case 'team_member.updated': {
      const teamMember = data?.object?.team_member;
      if (teamMember) await upsertTeamMember(teamMember, aervMerchantId);
      break;
    }

    default:
      console.log('Unhandled Square webhook event type:', type);
  }
}

async function syncSingleOrder(client, merchantId, orderId) {
  const response = await client.ordersApi.retrieveOrder(orderId);
  if (response.result.order) {
    await upsertOrders([response.result.order], merchantId, response.result.order.locationId);
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
      payment.amountMoney?.amount || 0, payment.tipMoney?.amount || 0,
      payment.amountMoney?.currency || 'USD', payment.status,
      payment.sourceType || null,
      payment.cardDetails?.card?.cardBrand || null,
      payment.locationId || null,
      payment.createdAt, payment.updatedAt,
      JSON.stringify(payment),
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
      member.createdAt, member.updatedAt, JSON.stringify(member),
    ]
  ).catch(err => console.warn('Could not upsert team member:', err.message));
}

async function getTokensBySquareMerchant(squareMerchantId) {
  const result = await pool.query(
    `SELECT aervo_merchant_id FROM square_connections WHERE square_merchant_id = $1`,
    [squareMerchantId]
  );
  if (!result.rows.length) return null;
  return await getTokensByMerchant(result.rows[0].aervo_merchant_id);
}

module.exports = { handleWebhookEvent, verifyWebhookSignature };