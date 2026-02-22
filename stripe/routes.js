const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');

// Price IDs from Stripe dashboard — we'll add these next
const PLANS = {
  essential_monthly: 'price_essential_monthly',
  essential_annual:  'price_essential_annual',
  pro_monthly:       'price_pro_monthly',
  pro_annual:        'price_pro_annual',
  business_monthly:  'price_business_monthly',
  business_annual:   'price_business_annual',
};

// Create checkout session
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

// Get current plan
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