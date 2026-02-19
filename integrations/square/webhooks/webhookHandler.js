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

  console.log('Processing Square webhook', { type, squareMerchantId });

  const tokens = await getTokensBySquareMerchant(squareMerchantId);
  if (!tokens) {
    console.warn('Received webhook for unknown Square merchant', { squareMerchantId });
    return;
  }

  const { aervMerchantId, accessToken } = tokens;
  const client = buildSquareClient(accessToken);

  switch (type) {
    case 'order.created':
    case 'order.updated':
    case 'order.fulfillment.updated': {
      const orderId = data?.object?.order_created?.order_id ||
                      data?.object?.order_updated?.order_id ||
                      data?.id;
      if (orderId) await syncSingleOrder(client, aervMerchantId, orderId);
      break;
    }

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

    case 'catalog.version.updated': {
      console.log('Catalog updated, triggering re-sync', { aervMerchantId });
      await syncCatalog({ client, merchantId: aervMerchantId });
      break;
    }

    default:
      console.log('Unhandled Square webhook event type', { type });
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

async function getTokensBySquareMerchant(squareMerchantId) {
  const result = await pool.query(
    `SELECT aervo_merchant_id, access_token_enc, refresh_token_enc, expires_at
     FROM square_connections WHERE square_merchant_id = $1`,
    [squareMerchantId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    aervMerchantId: row.aervo_merchant_id,
    accessToken: await getTokensByMerchant(row.aervo_merchant_id).then(t => t?.accessToken),
  };
}

module.exports = { handleWebhookEvent, verifyWebhookSignature };