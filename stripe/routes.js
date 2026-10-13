const express = require('express');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');

const PLANS = {
  essential_monthly: 'price_1T3VjkF2vcu0U1CfNPjrKtjj',
  essential_annual:  'price_1T3VkuF2vcu0U1Cfb6Zm94uK',
  pro_monthly:       'price_1T3VmhF2vcu0U1CfIkvMnIVy',
  pro_annual:        'price_1T3Vn7F2vcu0U1Cfac3v6u08',
  business_monthly:  'price_1T3VnxF2vcu0U1Cf7gmi8az0',
  business_annual:   'price_1T3VoLF2vcu0U1CfB3oeV05a',
};

const PRICE_TO_PLAN = Object.fromEntries(
  Object.entries(PLANS).map(([planId, priceId]) => [priceId, planId.split('_')[0]])
);

// Stripe -> users.plan. Called only after the webhook signature is verified.
async function applyStripeEvent(event) {
  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return;
      if (obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') return;
      const planId = obj.metadata && obj.metadata.planId;
      const userId = obj.metadata && obj.metadata.userId;
      if (!userId || !Object.prototype.hasOwnProperty.call(PLANS, planId)) {
        console.warn('Stripe checkout without usable metadata', { id: obj.id });
        return;
      }
      await pool.query(
        `UPDATE users SET plan = $1, stripe_customer_id = $2, stripe_subscription_id = $3 WHERE id = $4`,
        [planId.split('_')[0], obj.customer, obj.subscription, userId]
      );
      console.log('Stripe: plan activated', { userId, plan: planId.split('_')[0] });
      return;
    }

    case 'customer.subscription.updated': {
      const priceId = obj.items && obj.items.data[0] && obj.items.data[0].price.id;
      if (['canceled', 'unpaid', 'incomplete_expired'].includes(obj.status)) {
        await pool.query(`UPDATE users SET plan = 'free' WHERE stripe_subscription_id = $1`, [obj.id]);
      } else if (['active', 'trialing'].includes(obj.status) && PRICE_TO_PLAN[priceId]) {
        // Covers upgrades/downgrades made later (e.g. in the billing portal)
        await pool.query(`UPDATE users SET plan = $1 WHERE stripe_subscription_id = $2`, [PRICE_TO_PLAN[priceId], obj.id]);
      }
      return;
    }

    case 'customer.subscription.deleted':
      await pool.query(`UPDATE users SET plan = 'free' WHERE stripe_subscription_id = $1`, [obj.id]);
      console.log('Stripe: subscription ended', { subscription: obj.id });
      return;

    case 'invoice.payment_failed':
      // Stripe retries and then cancels (-> subscription.deleted); just record it
      console.warn('Stripe: payment failed', { customer: obj.customer, invoice: obj.id });
      return;

    default:
      return;
  }
}

// Both routes act on the logged-in user only. The user id and email come from
// the verified token / database, never from the request body.
module.exports = function stripeRoutes(authenticateToken) {
  const router = express.Router();

  pool
    .query(
      `ALTER TABLE users
         ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
         ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`
    )
    .catch((err) => console.error('Stripe columns:', err.message));

  // POST /stripe/webhook - called by Stripe, authenticated by its signature.
  // Needs STRIPE_WEBHOOK_SECRET (Stripe dashboard > Developers > Webhooks) and the
  // raw request body (captured in index.js before the JSON parser).
  router.post('/webhook', async (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      console.error('STRIPE_WEBHOOK_SECRET not set - rejecting Stripe webhook');
      return res.status(500).send('Webhook not configured');
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], secret);
    } catch (err) {
      console.warn('Stripe webhook signature check failed:', err.message);
      return res.status(400).send('Invalid signature');
    }

    try {
      await applyStripeEvent(event);
      res.json({ received: true });
    } catch (err) {
      console.error('Stripe webhook handling failed:', err.message);
      res.status(500).send('Handler error'); // Stripe will retry
    }
  });

  router.post('/create-checkout', authenticateToken, async (req, res) => {
    const { planId } = req.body;
    if (!Object.prototype.hasOwnProperty.call(PLANS, planId)) {
      return res.status(400).json({ error: 'Unknown plan' });
    }

    try {
      const userId = String(req.user.userId);
      const user = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.userId]);
      if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        customer_email: user.rows[0].email,
        line_items: [{ price: PLANS[planId], quantity: 1 }],
        success_url: 'https://aervoapp.com/dashboard?upgraded=true',
        cancel_url: 'https://aervoapp.com/pricing',
        metadata: { userId, planId },
      });
      res.json({ url: session.url });
    } catch (err) {
      console.error('Stripe checkout error:', err.message);
      res.status(500).json({ error: 'Could not start checkout' });
    }
  });

  router.get('/plan', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.userId]);
      res.json({ plan: result.rows[0]?.plan || 'starter' });
    } catch (err) {
      console.error('Stripe plan error:', err.message);
      res.status(500).json({ error: 'Could not load plan' });
    }
  });

  return router;
};
