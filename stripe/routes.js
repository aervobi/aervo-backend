const express = require('express');
const router = express.Router();
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

router.post('/create-checkout', async (req, res) => {
  const { planId, userId, email } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: PLANS[planId], quantity: 1 }],
      success_url: 'https://aervoapp.com/dashboard?upgraded=true',
      cancel_url: 'https://aervoapp.com/pricing',
      metadata: { userId, planId },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/plan', async (req, res) => {
  const { userId } = req.query;
  try {
    const result = await pool.query(
      'SELECT plan, plan_status FROM users WHERE id = $1',
      [userId]
    );
    res.json({ plan: result.rows[0]?.plan || 'starter' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;