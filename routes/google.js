const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URL
);

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key_change_me';

// ============= GOOGLE SIGN IN - Get auth URL =============
router.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['profile', 'email'],
    redirect_uri: process.env.GOOGLE_REDIRECT_URL
  });
  res.json({ url });
});

// ============= GOOGLE SIGN IN - Callback =============
router.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken({
      code: code,
      redirect_uri: process.env.GOOGLE_REDIRECT_URL
    });
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    let userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [data.email]
    );

    let user;
    let isNewUser = false;

    if (userResult.rows.length === 0) {
      isNewUser = true;
      const insertResult = await pool.query(
        `INSERT INTO users (email, company_name, role, email_verified, google_id, avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, company_name, role`,
        [data.email, data.name, 'Owner', true, data.id, data.picture]
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

    const redirectPage = isNewUser ? 'onboarding' : 'dashboard';
    res.redirect(`https://aervoapp.com/${redirectPage}?token=${token}&name=${encodeURIComponent(data.given_name)}`);

  } catch (err) {
    console.error('Google auth error:', err);
    res.redirect('https://aervoapp.com/login?error=google_failed');
  }
});

module.exports = router;