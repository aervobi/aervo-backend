require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const sgMail = require("@sendgrid/mail");
const crypto = require("crypto");

// ================== SENDGRID SETUP ==================
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Welcome email helper
async function sendWelcomeEmail(toEmail, companyName) {
  const msg = {
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL, // e.g. no-reply@aervoapp.com
    subject: "Welcome to Aervo",
    html: `
      <div style="background:#050817;padding:40px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#0a0f2b;border-radius:14px;overflow:hidden;color:#d6def8;">
          <tr>
            <td style="padding:32px 40px;text-align:center;background:#050817;border-bottom:1px solid rgba(255,255,255,0.05);">
              <div style="font-size:13px;letter-spacing:4px;color:#8fbfff;margin-top:8px;">AERVO</div>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px 20px;">
              <h1 style="margin:0;font-size:26px;color:#e5ecff;font-weight:600;">
                Welcome to Aervo, ${companyName || "there"} 👋
              </h1>
              <p style="margin:12px 0 0;font-size:15px;color:#9ca7d6;line-height:1.7;">
                Your dashboard is ready. You can log in any time at
                <a href="https://aervoapp.com/login.html" style="color:#8fbfff;">aervoapp.com</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 40px;text-align:center;border-top:1px solid rgba(255,255,255,0.05);font-size:12px;color:#6c7598;">
              You're receiving this email because you created an Aervo account.<br><br>
              © ${new Date().getFullYear()} Aervo — All rights reserved.
            </td>
          </tr>
        </table>
      </div>
    `,
  };

  await sgMail.send(msg);
  console.log("Welcome email sent to", toEmail);
}

// Password reset email helper
async function sendPasswordResetEmail(toEmail, token) {
  const baseUrl =
    process.env.FRONTEND_BASE_URL || "https://aervoapp.com"; // fallback

  const resetUrl = `${baseUrl.replace(/\/+$/, "")}/reset-password.html?token=${encodeURIComponent(
    token
  )}`;

  const msg = {
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL, // e.g. no-reply@aervoapp.com
    subject: "Reset your Aervo password",
    html: `
      <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px;">
        <h2 style="color: #111827;">Reset your Aervo password</h2>
        <p>We received a request to reset the password for your Aervo account.</p>
        <p>If you made this request, click the button below:</p>
        <p>
          <a href="${resetUrl}"
             style="display:inline-block; padding: 10px 18px; background:#4f46e5; color:#ffffff; text-decoration:none; border-radius:999px;">
            Reset password
          </a>
        </p>
        <p>Or copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color:#374151;">${resetUrl}</p>
        <p>If you did not request this, you can ignore this email.</p>
        <p style="margin-top:24px; font-size:12px; color:#6b7280;">&copy; ${new Date().getFullYear()} Aervo</p>
      </div>
    `,
  };

  await sgMail.send(msg);
  console.log("Password reset email sent to", toEmail);
}

// ================== IN-MEMORY RESET TOKEN STORE ==================
const passwordResetTokens = {}; // token -> { email, expiresAt }

// ================== EXPRESS APP ==================
const app = express();

app.use(cors());
app.use(express.json());

// ================== POSTGRES POOL ==================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// ================== JWT SECRET ==================
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_key_change_me";

// ================== HEALTH CHECKS ==================
app.get("/", (req, res) => {
  res.send("Aervo backend is running!");
});

app.get("/api/status", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS now");
    res.json({
      status: "ok",
      app: "Aervo backend",
      environment: process.env.NODE_ENV || "development",
      dbTime: result.rows[0].now,
    });
  } catch (err) {
    console.error("Status check error:", err);
    res.status(500).json({
      status: "error",
      message: "Database connection failed",
    });
  }
});

// ================== TEST EMAIL ENDPOINT ==================
app.get("/api/test-email", async (req, res) => {
  const to = req.query.to || process.env.TEST_EMAIL || process.env.SENDGRID_FROM_EMAIL;

  try {
    await sendWelcomeEmail(to, "Aervo Test Company");
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (err) {
    console.error("Test email failed:", err);
    const sgError =
      err.response?.body?.errors?.[0]?.message ||
      err.message ||
      "Error sending test email.";
    res.status(500).json({ ok: false, error: sgError });
  }
});

// ================== SIGNUP ==================
app.post("/api/signup", async (req, res) => {
  try {
    const { email, password, companyName } = req.body;

    if (!email || !password || !companyName) {
      return res.status(400).json({
        success: false,
        message: "Email, password, and company name are required.",
      });
    }

    const normalizedEmail = email.toLowerCase();

    // 1) Check if user already exists
    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists.",
      });
    }

    // 2) Hash password
    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // 3) Insert user
    const insertResult = await pool.query(
      `
      INSERT INTO users (email, password_hash, company_name, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email, company_name, role
      `,
      [normalizedEmail, passwordHash, companyName, "Owner"]
    );

    const user = insertResult.rows[0];

    // 4) Create JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 5) Respond immediately
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        companyName: user.company_name,
        role: user.role,
      },
    });

    // 6) Fire welcome email in the background (don't block signup)
    sendWelcomeEmail(normalizedEmail, companyName).catch((err) => {
      console.error("Welcome email failed:", err);
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({
      success: false,
      message: "Error creating account. Please try again.",
    });
  }
});

// ================== LOGIN ==================
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    const normalizedEmail = email.toLowerCase();

    const result = await pool.query(
      "SELECT id, email, password_hash, company_name, role FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials.",
      });
    }

    const user = result.rows[0];

    // Compare password
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials.",
      });
    }

    // Record last_login
    await pool.query("UPDATE users SET last_login = NOW() WHERE id = $1", [
      user.id,
    ]);

    // Create JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        companyName: user.company_name,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      success: false,
      message: "Server error during login.",
    });
  }
});

// ================== FORGOT PASSWORD ==================
// --- FORGOT PASSWORD: send reset link via email (DB-backed) ---
app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res
      .status(400)
      .json({ success: false, message: "Email is required." });
  }

  try {
    const normalizedEmail = email.toLowerCase();

    // Look up user by email
    const result = await pool.query(
      "SELECT id, email FROM users WHERE email = $1",
      [normalizedEmail]
    );

    // Don't leak whether the email exists
    if (result.rowCount === 0) {
      return res.json({
        success: true,
        message: "If an account exists, we sent a reset link.",
      });
    }

    const user = result.rows[0];

    // Generate token + expiry
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour from now

    // Save token + expiry in the users table
    await pool.query(
      `
        UPDATE users
        SET password_reset_token = $1,
            password_reset_expires_at = $2
        WHERE id = $3
      `,
      [token, expiresAt, user.id]
    );

    // Build reset URL for the frontend
    const baseUrl =
      process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
    const resetLink = `${baseUrl.replace(/\/+$/, "")}/reset-password.html?token=${encodeURIComponent(
      token
    )}`;

    // Send email with SendGrid
    const msg = {
      to: user.email,
      from: process.env.SENDGRID_FROM_EMAIL, // e.g. no-reply@aervoapp.com (verified in SendGrid)
      subject: "Reset your Aervo password",
      html: `
        <p>Hi,</p>
        <p>We received a request to reset your Aervo password.</p>
        <p>
          <a href="${resetLink}">Click here to reset your password</a>.
          This link will expire in 1 hour.
        </p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    };

    await sgMail.send(msg);

    return res.json({
      success: true,
      message: "If an account exists, we sent a reset link.",
    });
  } catch (err) {
    console.error("Error in /api/forgot-password", err);

    const sgError =
      err.response?.body?.errors?.[0]?.message ||
      err.message ||
      "Something went wrong on the server.";

    return res.status(500).json({
      success: false,
      message: sgError,
    });
  }
});

    const userEmail = result.rows[0].email;

    // Generate token and store it in memory (demo)
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 1000 * 60 * 60; // 1 hour

    passwordResetTokens[token] = { email: userEmail, expiresAt };

    // Send email via SendGrid helper
    await sendPasswordResetEmail(userEmail, token);

    return res.json({
      success: true,
      message: "If an account exists, we sent a reset link.",
    });
  } catch (err) {
    console.error("Error in /api/forgot-password", err);

    const sgError =
      err.response?.body?.errors?.[0]?.message ||
      err.message ||
      "Something went wrong on the server.";

    return res.status(500).json({
      success: false,
      message: sgError,
    });
  }
});

// ================== RESET PASSWORD ==================
app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Token and new password are required.",
    });
  }

  const record = passwordResetTokens[token];

  if (!record) {
    return res.status(400).json({
      success: false,
      message: "Invalid or expired reset link.",
    });
  }

  if (record.expiresAt < Date.now()) {
    delete passwordResetTokens[token];
    return res.status(400).json({
      success: false,
      message: "Reset link has expired. Please request a new one.",
    });
  }

  try {
    const hashed = await bcrypt.hash(newPassword, 10);

    await pool.query(
      "UPDATE users SET password_hash = $1 WHERE email = $2",
      [hashed, record.email.toLowerCase()]
    );

    // Kill the token so it can't be reused
    delete passwordResetTokens[token];

    return res.json({
      success: true,
      message: "Password updated. You can now log in.",
    });
  } catch (err) {
    console.error("Error in /api/reset-password", err);
    return res.status(500).json({
      success: false,
      message: "Something went wrong.",
    });
  }
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});