require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const sgMail = require("@sendgrid/mail");
const crypto = require("crypto");

// ============= SENDGRID SETUP =============
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ================== WELCOME EMAIL (AERVO THEME) ==================
async function sendWelcomeEmail({ toEmail, companyName }) {
  const appUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";

  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Welcome to Aervo</title>
  </head>
  <body style="margin:0; padding:0; background:#020617; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;">
    <table width="100%" cellspacing="0" cellpadding="0" style="background:radial-gradient(circle at top, #1d2a64 0, #020617 55%, #020617 100%); padding:32px 16px;">
      <tr>
        <td align="center">
          <!-- Outer card -->
          <table width="600" cellspacing="0" cellpadding="0" style="max-width:600px; background:#020617; border-radius:24px; border:1px solid #1e293b; box-shadow:0 30px 80px rgba(15,23,42,0.75); overflow:hidden;">
            <!-- Logo + chip -->
            <tr>
              <td style="padding:32px 32px 0 32px;" align="left">
                <img src="https://aervoapp.com/assets/aervo-logo-email.png" alt="Aervo" style="height:28px; display:block; margin-bottom:20px;" />
                <div style="display:inline-block; padding:4px 14px; border-radius:999px; border:1px solid #1f2937; background:rgba(15,23,42,0.85); color:#e5e7eb; font-size:12px; letter-spacing:0.06em; text-transform:uppercase;">
  👋 Welcome aboard
</div>
              </td>
            </tr>

            <!-- Hero section -->
            <tr>
              <td style="padding:20px 32px 4px 32px;" align="left">
                <h1 style="margin:0 0 12px 0; font-size:28px; line-height:1.25; color:#f9fafb;">
                  Welcome to Aervo${companyName ? `, <span style="color:#a5b4fc;">${companyName}</span>` : ""} 🌌
                </h1>
                <p style="margin:0; font-size:15px; line-height:1.6; color:#cbd5f5;">
                  Your smart command center for the business just went live.
                  Imagine the dashboard you saw on signup, powered by your real sales,
                  customers, and inventory. That’s where we’re headed together.
                </p>
              </td>
            </tr>

            <!-- Three feature cards -->
            <tr>
              <td style="padding:24px 32px 16px 32px;">
                <table width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <!-- Card 1 -->
                    <td width="33.33%" valign="top" style="padding-right:8px;">
                      <div style="border-radius:18px; background:linear-gradient(135deg, #020617 0%, #020617 45%, #111827 100%); border:1px solid #1f2937; padding:16px 14px; height:100%;">
                        <div style="font-size:24px; margin-bottom:6px;">📊</div>
                        <div style="font-size:14px; font-weight:600; color:#e5e7eb; margin-bottom:4px;">
                          See your performance
                        </div>
                        <div style="font-size:13px; line-height:1.5; color:#9ca3af;">
                          Get a simple overview of sales and trends without digging through reports.
                        </div>
                      </div>
                    </td>

                    <!-- Card 2 -->
                    <td width="33.33%" valign="top" style="padding:0 4px;">
                      <div style="border-radius:18px; background:linear-gradient(135deg, #020617 0%, #020617 45%, #111827 100%); border:1px solid #1f2937; padding:16px 14px; height:100%;">
                        <div style="font-size:24px; margin-bottom:6px;">🤖</div>
                        <div style="font-size:14px; font-weight:600; color:#e5e7eb; margin-bottom:4px;">
                          Ask Aervo anything
                        </div>
                        <div style="font-size:13px; line-height:1.5; color:#9ca3af;">
                          Ask natural questions like “How did we do this week?” and get clear answers in seconds.
                        </div>
                      </div>
                    </td>

                    <!-- Card 3 -->
                    <td width="33.33%" valign="top" style="padding-left:8px;">
                      <div style="border-radius:18px; background:linear-gradient(135deg, #020617 0%, #020617 45%, #111827 100%); border:1px solid #1f2937; padding:16px 14px; height:100%;">
                        <div style="font-size:24px; margin-bottom:6px;">⚡</div>
                        <div style="font-size:14px; font-weight:600; color:#e5e7eb; margin-bottom:4px;">
                          Spot what matters
                        </div>
                        <div style="font-size:13px; line-height:1.5; color:#9ca3af;">
                          See slowdowns, surprises, and opportunities before they become problems.
                        </div>
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- CTA -->
            <tr>
              <td style="padding:16px 32px 6px 32px;" align="left">
                <p style="margin:0 0 14px 0; font-size:14px; line-height:1.5; color:#cbd5f5;">
                  Whenever you’re ready, step back into your command center and start exploring your sample dashboard.
                </p>
                <table cellspacing="0" cellpadding="0">
                  <tr>
                    <td>
                      <a href="${appUrl}"
                        style="display:inline-block; padding:12px 22px; border-radius:999px; background:linear-gradient(135deg,#4f46e5,#6366f1); color:#f9fafb; text-decoration:none; font-size:14px; font-weight:600; box-shadow:0 12px 30px rgba(79,70,229,0.45);">
                        Go to your dashboard →
                      </a>
                    </td>
                    <td style="padding-left:12px; font-size:13px; color:#6b7280;">
                      or visit <a href="${appUrl}" style="color:#a5b4fc; text-decoration:none;">aervoapp.com</a> anytime.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Friendly footer -->
            <tr>
              <td style="padding:18px 32px 26px 32px; border-top:1px solid #111827;" align="left">
                <p style="margin:0 0 4px 0; font-size:12px; color:#6b7280;">
                  You’re receiving this email because an Aervo workspace was created with this address.
                </p>
                <p style="margin:0; font-size:12px; color:#4b5563;">
                  If this wasn’t you, please email support@aervoapp.com for further assistance.
                <p style="margin:12px 0 0 0; font-size:11px; color:#374151;">
                  © ${new Date().getFullYear()} Aervo. All rights reserved.
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;

  await sgMail.send({
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: "Welcome to Aervo 🎉 Your new command center is ready",
    html,
  });
}

// Helper: Aervo-styled Reset Password Email
async function sendPasswordResetEmail({ toEmail, companyName, token }) {
  const baseUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const resetUrl = `${cleanBase}/reset-password.html?token=${encodeURIComponent(
    token
  )}`;

  const html = `
  <div style="background:#050817;padding:40px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#050818;border-radius:16px;overflow:hidden;color:#e5ecff;border:1px solid rgba(129,140,248,0.3)">
      
      <tr>
        <td style="padding:28px 40px 18px;background:radial-gradient(circle at top,#1d2a4f,#050818);border-bottom:1px solid rgba(129,140,248,0.3);">
          <table width="100%">
            <tr>
              <td style="vertical-align:middle;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <img src="https://aervoapp.com/logo.png" alt="Aervo" width="40" style="border-radius:999px;box-shadow:0 0 12px rgba(129,140,248,0.7);" />
                  <div>
                    <div style="font-size:13px;letter-spacing:4px;color:#a5b4fc;text-transform:uppercase;">AERVO</div>
                    <div style="font-size:12px;color:#9ca3af;">A higher view of your business</div>
                  </div>
                </div>
              </td>
              <td style="text-align:right;font-size:12px;color:#9ca3af;">
                Password reset request
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <tr>
        <td style="padding:32px 40px 24px;">
          <h1 style="margin:0 0 12px;font-size:22px;color:#e5ecff;font-weight:600;">
            Hey there${companyName ? ` from ${companyName}` : ""} 👋
          </h1>
          <p style="margin:0 0 10px;font-size:14px;color:#d1d5db;line-height:1.7;">
            We received a request to reset the password for your Aervo account.
          </p>
          <p style="margin:0 0 16px;font-size:14px;color:#d1d5db;line-height:1.7;">
            If you forgot your password or you're having trouble signing in, no worries.
            Just click the button below and we’ll help you get back into your account.
          </p>
        </td>
      </tr>

      <tr>
        <td style="padding:0 40px 24px;">
          <a href="${resetUrl}" style="
            display:inline-block;
            padding:12px 26px;
            border-radius:999px;
            background:linear-gradient(135deg,#4f46e5,#6366f1);
            color:#f9fafb;
            font-size:14px;
            text-decoration:none;
            font-weight:500;
            box-shadow:0 12px 30px rgba(79,70,229,0.45);
          ">
            Reset password
          </a>
          <p style="margin:14px 0 0;font-size:12px;color:#9ca3af;">
            This link will only work once and will expire in about an hour.
          </p>
        </td>
      </tr>

      <tr>
        <td style="padding:0 40px 28px;">
          <p style="margin:0 0 8px;font-size:13px;color:#9ca3af;">
            Or copy and paste this link into your browser:
          </p>
          <p style="margin:0;font-size:12px;color:#9ca3af;word-break:break-all;">
            ${resetUrl}
          </p>
        </td>
      </tr>

      <tr>
        <td style="padding:0 40px 24px;">
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.7;">
            If you didn’t ask to reset your password, you can safely ignore this email.
            Your login details will stay the same.
          </p>
        </td>
      </tr>

      <tr>
        <td style="padding:18px 40px 26px;border-top:1px solid rgba(55,65,81,0.8);text-align:center;font-size:11px;color:#6b7280;">
          © ${new Date().getFullYear()} Aervo. All rights reserved.
        </td>
      </tr>
    </table>
  </div>
  `;

  await sgMail.send({
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: "Reset your Aervo password",
    html,
  });
}

// ============= EXPRESS + DB SETUP =============
const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_key_change_me";

// ============= HEALTH CHECKS =============
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

// Quick test endpoint for email
app.get("/api/test-email", async (req, res) => {
  const to = req.query.to || process.env.TEST_EMAIL;

  try {
    await sendWelcomeEmail({
      toEmail: to,
      companyName: "Aervo Test Company",
      userRole: "Owner",
    });
    res.json({ ok: true, message: `Test welcome email sent to ${to}` });
  } catch (err) {
    console.error("Test email failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============= SIGNUP =============
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

    // 5) Send response
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

    // 6) Send Aervo Welcome Email (new HTML design) in background
    sendWelcomeEmail({
      toEmail: normalizedEmail,
      companyName,
      userRole: user.role,
    }).catch((err) => console.error("Welcome email failed:", err));
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({
      success: false,
      message: "Error creating account. Please try again.",
    });
  }
});

// ============= LOGIN =============
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
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials." });
    }

    const user = result.rows[0];

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials." });
    }

    await pool.query("UPDATE users SET last_login = NOW() WHERE id = $1", [
      user.id,
    ]);

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

// ============= FORGOT PASSWORD (DB-backed) =============
app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email is required.",
    });
  }

  try {
    const normalizedEmail = email.toLowerCase();

    const result = await pool.query(
      "SELECT id, email, company_name FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (result.rowCount === 0) {
      // Don't leak whether the email exists
      return res.json({
        success: true,
        message: "If an account exists, we sent a reset link.",
      });
    }

    const user = result.rows[0];

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour

    await pool.query(
      `
        UPDATE users
        SET reset_token = $1,
            reset_token_expires = $2
        WHERE id = $3
      `,
      [token, expiresAt, user.id]
    );

    await sendPasswordResetEmail({
      toEmail: user.email,
      companyName: user.company_name,
      token,
    });

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

// ============= RESET PASSWORD (DB-backed) =============
app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Token and new password are required.",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT id, email
      FROM users
      WHERE reset_token = $1
        AND reset_token_expires > NOW()
      `,
      [token]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired reset link.",
      });
    }

    const user = result.rows[0];

    const hashed = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `
      UPDATE users
      SET password_hash = $1,
          reset_token = NULL,
          reset_token_expires = NULL
      WHERE id = $2
      `,
      [hashed, user.id]
    );

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

// ============= START SERVER =============
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});