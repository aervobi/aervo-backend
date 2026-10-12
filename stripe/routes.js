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

// Both routes act on the logged-in user only. The user id and email come from
// the verified token / database, never from the request body.
module.exports = function stripeRoutes(authenticateToken) {
  const router = express.Router();

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
