const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

const { JWT_SECRET } = require('../middleware/auth');

router.post('/api/onboarding', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch (e) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }
    const { company_name, business_type, role, platform, shopify_url, location } = req.body;

    await pool.query(
      `UPDATE users SET company_name=$1, business_type=$2, role=$3, platform=$4, shopify_url=$5, location=$6, onboarded=true WHERE id=$7`,
      [company_name, business_type, role, platform, shopify_url, location, decoded.userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to save onboarding data' });
  }
});

module.exports = router;