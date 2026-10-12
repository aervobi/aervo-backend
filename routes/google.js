const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db');

// .env historically uses _URI, Render uses _URL; accept either
const REDIRECT_URL = process.env.GOOGLE_REDIRECT_URL || process.env.GOOGLE_REDIRECT_URI;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URL
);

const { JWT_SECRET } = require('../middleware/auth');

// ============= GOOGLE SIGN IN - Get auth URL =============
router.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['profile', 'email'],
    redirect_uri: REDIRECT_URL
  });
  res.json({ url });
});

// ============= GOOGLE SIGN IN - Callback =============
router.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error || !code) {
      // Google sends ?error=access_denied when the user cancels the consent screen
      return res.redirect('https://aervoapp.com/login?error=google_cancelled');
    }
    const { tokens } = await oauth2Client.getToken({
      code: code,
      redirect_uri: REDIRECT_URL
    });
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    // Email signup lowercases addresses, so match that here
    const email = String(data.email).toLowerCase();

    let userResult = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = $1',
      [email]
    );

    let user;
    let isNewUser = false;

    if (userResult.rows.length === 0) {
      isNewUser = true;
      // users.password_hash is required for every other signup path (email,
      // Shopify), so Google accounts get an unguessable random one. They sign
      // in through Google; "Forgot password" can still set a real password.
      const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const insertResult = await pool.query(
        `INSERT INTO users (email, password_hash, company_name, role, email_verified, google_id, avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, email, company_name, role`,
        [email, passwordHash, data.name, 'Owner', true, data.id, data.picture]
      );
      user = insertResult.rows[0];
    } else {
      user = userResult.rows[0];
      await pool.query(
        'UPDATE users SET google_id = $1, avatar_url = $2 WHERE id = $3',
        [data.id, data.picture, user.id]
      );
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Also resume onboarding for Google users who signed up but never finished
    // it (onboarding saves `platform`, so an empty one means it never completed).
    const needsOnboarding = isNewUser || (!user.onboarded && !user.platform);
    const redirectPage = needsOnboarding ? 'onboarding' : 'dashboard';
    res.redirect(`https://aervoapp.com/${redirectPage}?token=${token}&name=${encodeURIComponent(data.given_name)}`);

  } catch (err) {
    // Google's own errors carry the useful detail in err.response.data
    console.error('Google auth error:', err.message, err.code || '', err.response?.data || '');
    res.redirect('https://aervoapp.com/login?error=google_failed');
  }
});

module.exports = router;