const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const SECRET = process.env.SHOPIFY_CLIENT_SECRET;

function verifyWebhook(req, res, next) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const hash = crypto
    .createHmac('sha256', SECRET)
    .update(req.body) // raw body
    .digest('base64');

  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac))) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

// GDPR compliance webhooks
router.post('/customers/data_request', verifyWebhook, (req, res) => {
  // Log or handle the data request
  res.sendStatus(200);
});

router.post('/customers/redact', verifyWebhook, (req, res) => {
  // Delete customer data
  res.sendStatus(200);
});

router.post('/shop/redact', verifyWebhook, (req, res) => {
  // Delete shop data
  res.sendStatus(200);
});

module.exports = router;