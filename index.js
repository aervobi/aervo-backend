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

// Helper: Aervo-styled Welcome Email
async function sendWelcomeEmail({ toEmail, companyName, userRole }) {
  const appUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";

  const html = `
  <div style="background:#050817;padding:40px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#0a0f2b;border-radius:14px;overflow:hidden;color:#d6def8;">
      
      <tr>
        <td style="padding:32px 40px;text-align:center;background:#050817;border-bottom:1px solid rgba(255,255,255,0.05);">
          <img src="https://aervoapp.com/logo.png" width="78" style="opacity:0.95;filter:drop-shadow(0 0 10px rgba(137,180,255,0.9))" alt="Aervo Logo">
          <div style="font-size:13px;letter-spacing:4px;color:#8fbfff;margin-top:8px;">AERVO</div>
        </td>
      </tr>

      <tr>
        <td style="padding:40px 40px 20px;">
          <h1 style="margin:0;font-size:26px;color:#e5ecff;font-weight:600;">
            Welcome to Aervo, ${companyName || "there"} 👋
          </h1>
          <p style="margin:12px 0 0;font-size:15px;color:#9ca7d6;line-height:1.7;">
            We're excited to have you here. Aervo helps you understand your business faster with clear dashboards and simple AI insights you can act on.
          </p>
        </td>
      </tr>

      <tr>
        <td style="padding:20px 40px;">
          <div style="
            border-radius:14px;
            border:1px solid rgba(143,191,255,0.35);
            background:radial-gradient(circle at top left,#1e2f55,#0a0f2b);
            padding:24px 22px;
            box-shadow:0 0 26px rgba(80,130,255,0.25);
          ">
            <h2 style="margin:0 0 10px;color:#e5ecff;font-size:18px;font-weight:500;">Your new command center</h2>
            <p style="margin:0;color:#a6b3dd;font-size:14px;line-height:1.7;">
              Track revenue, trends, products, and customer behavior all in one place.
              Aervo shows you the story behind your numbers.
            </p>
            <ul style="margin:16px 0 0 20px;padding:0;color:#c2cff6;font-size:14px;line-height:1.8;">
              <li>Clean dashboards that highlight what matters</li>
              <li>Live performance insights at a glance</li>
              <li>AI explanations you can understand instantly</li>
            </ul>
          </div>
        </td>
      </tr>

      <tr>
        <td style="padding:10px 40px 32px;">
          <a href="${appUrl}/dashboard.html"
            style="
              display:inline-block;
              padding:12px 26px;
              background:#1a243d;
              border-radius:999px;
              color:#b4cdff;
              font-size:15px;
              text-decoration:none;
              box-shadow:0 0 18px rgba(137,180,255,0.6),0 0 40px rgba(80,130,255,0.4);
            "
          >
            Open your dashboard
          </a>
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
  `;

  await sgMail.send({
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: "Welcome to Aervo",
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