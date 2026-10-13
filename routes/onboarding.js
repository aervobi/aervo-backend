const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/auth');

router.post('/api/onboarding', authenticateToken, async (req, res) => {
  try {
    const { company_name, business_type, role, platform, shopify_url, location } = req.body;

    await pool.query(
      `UPDATE users SET company_name=$1, business_type=$2, role=$3, platform=$4, shopify_url=$5, location=$6, onboarded=true WHERE id=$7`,
      [company_name, business_type, role, platform, shopify_url, location, req.user.userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to save onboarding data' });
  }
});

module.exports = router;
