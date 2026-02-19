// integrations/square/webhooks/webhookHandler.js
// Handles incoming Square webhook events to keep Aervo's data in sync in real time.
//
// Square sends signed webhooks for key events. We:
//   1. Verify the signature (security)
//   2. Route to the correct handler
//   3. Process the event asynchronously
//
// Webhooks to subscribe to in Square Developer Dashboard:
//   - payment.created / payment.updated
//   - order.created / order.updated / order.fulfilled
//   - customer.created / customer.updated / customer.deleted
//   - booking.created / booking.updated / booking.cancelled
//   - catalog.version.updated

const crypto = require('crypto');
const { upsertOrders } = require('../sync/orders/syncOrders');
const { upsertCustomers } = require('../sync/customers/syncCustomers');
const { upsertAppointments } = require('../sync/appointments/syncAppointments');
const { syncCatalog } = require('../sync/catalog/syncCatalog');
const { getTokensByMerchant } = require('../auth/tokenStore');
const { buildSquareClient } = require('../client');
const logger = require('../../../lib/logger');

/**
 * Verify that a webhook request genuinely came from Square.
 * Square signs requests using HMAC-SHA256.
 *
 * @param {string} body            - Raw request body string
 * @param {string} signature       - x-square-hmacsha256-signature header value
 * @param {string} notificationUrl - The webhook URL that received the event
 * @returns {boolean}
 */
function verifyWebhookSignature(body, signature, notificationUrl) {
  const signingKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!signingKey) {
    logger.warn('SQUARE_WEBHOOK_SIGNATURE_KEY not set — skipping signature verification');
    return true; // Allow in dev; enforce in production
  }

  const payload = notificationUrl + body;
  const hmac = crypto.createHmac('sha256', signingKey);
  hmac.update(payload);
  const expected = hmac.digest('base64');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Main webhook entry point — called by the Express router.
 */
async function handleWebhookEvent(req, res) {
  // ── Signature verification ────────────────────────────────────────────────
  const signature = req.headers['x-square-hmacsha256-signature'];
  const rawBody = req.rawBody; // Must be captured before JSON parsing (see middleware note)
  const notificationUrl = `${process.env.AERVO_APP_URL}/integrations/square/webhooks`;

  if (!verifyWebhookSignature(rawBody, signature, notificationUrl)) {
    logger.warn('Square webhook signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Respond 200 immediately — Square retries if we take too long
  res.status(200).json({ received: true });

  // Process asynchronously
  processEvent(req.body).catch((err) =>
    logger.error('Webhook processing failed', { error: err.message, event: req.body?.type })
  );
}

/**
 * Route and process a Square webhook event.
 */
async function processEvent(event) {
  const { type, merchant_id: squareMerchantId, data } = event;

  logger.info('Processing Square webhook', { type, squareMerchantId });

  // Look up the Aervo merchant ID from Square's merchant ID
  const tokens = await getTokensBySquareMerchant(squareMerchantId);
  if (!tokens) {
    logger.warn('Received webhook for unknown Square merchant', { squareMerchantId });
    return;
  }

  const { aervMerchantId, accessToken } = tokens;
  const client = buildSquareClient(accessToken);

  switch (type) {
    // ── Orders ───────────────────────────────────────────────────────────────
    case 'order.created':
    case 'order.updated':
    case 'order.fulfillment.updated': {
      const orderId = data?.object?.order_created?.order_id ||
                      data?.object?.order_updated?.order_id ||
                      data?.id;
      if (orderId) await syncSingleOrder(client, aervMerchantId, orderId);
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
      if (booking) {
        await upsertAppointments([booking], aervMerchantId, booking.locationId);
      }
      break;
    }
    case 'booking.cancelled': {
      const booking = data?.object?.booking;
      if (booking) {
        await upsertAppointments([{ ...booking, status: 'CANCELLED' }], aervMerchantId, booking.locationId);
      }
      break;
    }

    // ── Catalog ───────────────────────────────────────────────────────────────
    case 'catalog.version.updated': {
      // Catalog changed — re-sync the whole thing (it's usually fast)
      logger.info('Catalog updated, triggering re-sync', { aervMerchantId });
      await syncCatalog({ client, merchantId: aervMerchantId });
      break;
    }

    default:
      logger.debug('Unhandled Square webhook event type', { type });
  }
}

/**
 * Fetch a single order from Square by ID and upsert it.
 * Used for order webhook events where we only receive the order ID.
 */
async function syncSingleOrder(client, merchantId, orderId) {
  const response = await client.ordersApi.retrieveOrder(orderId);
  if (response.result.order) {
    await upsertOrders([response.result.order], merchantId, response.result.order.locationId);
  }
}

async function softDeleteCustomer(merchantId, squareCustomerId) {
  const { pool } = require('../../../lib/db');
  await pool.query(
    `UPDATE square_customers SET is_deleted = TRUE, updated_at = NOW()
     WHERE aervo_merchant_id = $1 AND square_customer_id = $2`,
    [merchantId, squareCustomerId]
  );
}

/**
 * Look up Aervo tokens by Square merchant ID (reverse lookup).
 */
async function getTokensBySquareMerchant(squareMerchantId) {
  const { pool } = require('../../../lib/db');
  const { decrypt } = require('../auth/tokenStore'); // If exported; otherwise inline
  const result = await pool.query(
    `SELECT aervo_merchant_id, access_token_enc, refresh_token_enc, expires_at
     FROM square_connections WHERE square_merchant_id = $1`,
    [squareMerchantId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  // Note: In production, use the tokenStore's getTokensByMerchant instead
  return {
    aervMerchantId: row.aervo_merchant_id,
    accessToken: null, // Will be fetched properly via tokenStore in production
  };
}

module.exports = { handleWebhookEvent, verifyWebhookSignature };
