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

// ============= SMALL HELPER: BUSINESS TYPE =============
function inferBusinessType(companyName = "") {
  const n = companyName.toLowerCase();

  if (n.includes("coffee") || n.includes("café") || n.includes("cafe")) {
    return "coffee shop";
  }
  if (n.includes("shop") || n.includes("store") || n.includes("boutique")) {
    return "store";
  }
  if (n.includes("agency") || n.includes("studio")) {
    return "agency";
  }
  if (n.includes("barber") || n.includes("salon")) {
    return "salon";
  }
  if (n.includes("co.") || n.includes("company") || n.includes("inc")) {
    return "business";
  }

  return "business";
}

// ================== WELCOME EMAIL (BOLD, BIRD HERO, STORY INTRO) ==================
async function sendWelcomeEmail({ toEmail, companyName }) {
  const appUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";

  const safeCompany = companyName || "your business";

  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Welcome to Aervo</title>
  </head>
  <body style="margin:0; padding:0; background:#020617; font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#020617; padding:32px 0;">
      <tr>
        <td align="center">
          <!-- Outer card -->
          <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px; background:#020617; border-radius:24px; overflow:hidden; box-shadow:0 26px 80px rgba(15,23,42,0.85); border:1px solid #111827;">
            
            <!-- HERO WITH BIRD BACKGROUND -->
            <tr>
              <td style="
                padding:32px 32px 26px;
                background:
                  radial-gradient(circle at top left, #38bdf8 0, transparent 55%),
                  radial-gradient(circle at top right, #4f46e5 0, transparent 60%),
                  radial-gradient(circle at bottom, #0f172a 0, #020617 65%);
                color:#f9fafb;
                position:relative;
              ">

                <!-- ghost bird in the background -->
                <div style="
                  position:absolute;
                  right:18px;
                  top:18px;
                  width:140px;
                  opacity:0.16;
                  filter:drop-shadow(0 0 22px rgba(129,140,248,0.85));
                ">
                  <img src="https://aervoapp.com/logo.png" alt="" style="width:100%; display:block;" />
                </div>

                <!-- Aervo tiny logo + wordmark -->
                <div style="position:relative; z-index:2; margin-bottom:18px;">
                  <div style="font-size:11px; letter-spacing:0.22em; text-transform:uppercase; color:#d1d5db;">
                    AERVO
                  </div>
                </div>

                <!-- Story-style intro -->
                <div style="position:relative; z-index:2;">
                  <h1 style="margin:0 0 10px; font-size:26px; line-height:1.3; font-weight:650;">
                    Hi ${safeCompany}, welcome to Aervo 👋
                  </h1>
                  <p style="margin:0 0 10px; font-size:14px; line-height:1.7; color:#e5e7eb;">
                    Most days, running ${safeCompany.toLowerCase()} means juggling tabs, spreadsheets, and gut feeling.
                  </p>
                  <p style="margin:0; font-size:14px; line-height:1.7; color:#e5e7eb;">
                    Aervo is here to give you a higher view: one place where sales, inventory, and customer signals come together so you can see what’s working and what needs attention in seconds.
                  </p>
                </div>
              </td>
            </tr>

            <!-- WHAT AERVO IS BUILT TO DO -->
            <tr>
              <td style="padding:22px 32px 10px; background:#020617;">
                <p style="margin:0 0 10px; font-size:13px; letter-spacing:0.08em; text-transform:uppercase; color:#9ca3af; font-weight:600;">
                  Here’s what Aervo is built to help you do:
                </p>
                <ul style="margin:0 0 6px 18px; padding:0; font-size:14px; line-height:1.7; color:#e5e7eb;">
                  <li style="margin-bottom:4px;">
                    <strong>See today at a glance</strong> – one live view instead of ten different tabs.
                  </li>
                  <li style="margin-bottom:4px;">
                    <strong>Ask plain-language questions</strong> – like “How did we do this week?” or “What changed in online orders?” and get clear answers.
                  </li>
                  <li>
                    <strong>Spot slowdowns early</strong> – catch dips in sales, low stock, or rising returns before they turn into bigger problems.
                  </li>
                </ul>
              </td>
            </tr>

            <!-- FEATURE CARDS ROW -->
            <tr>
              <td style="padding:10px 24px 6px; background:#020617;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <!-- Card 1 -->
                    <td width="33.33%" valign="top" style="padding:8px;">
                      <div style="
                        border-radius:18px;
                        background:linear-gradient(145deg,#020617,#020617 45%,#0b1120 100%);
                        border:1px solid rgba(148,163,184,0.5);
                        padding:14px 12px;
                        height:100%;
                      ">
                        <div style="font-size:20px; margin-bottom:6px;">📈</div>
                        <div style="font-size:13px; font-weight:600; color:#f9fafb; margin-bottom:4px;">
                          Live overview
                        </div>
                        <div style="font-size:12px; line-height:1.6; color:#9ca3af;">
                          See key sales, inventory, and customer metrics in one clean place.
                        </div>
                      </div>
                    </td>

                    <!-- Card 2 -->
                    <td width="33.33%" valign="top" style="padding:8px;">
                      <div style="
                        border-radius:18px;
                        background:linear-gradient(145deg,#020617,#020617 45%,#111827 100%);
                        border:1px solid rgba(96,165,250,0.6);
                        padding:14px 12px;
                        height:100%;
                      ">
                        <div style="font-size:20px; margin-bottom:6px;">🤖</div>
                        <div style="font-size:13px; font-weight:600; color:#f9fafb; margin-bottom:4px;">
                          Explain the “why”
                        </div>
                        <div style="font-size:12px; line-height:1.6; color:#9ca3af;">
                          Get short explanations instead of raw charts, so you know what changed and why.
                        </div>
                      </div>
                    </td>

                    <!-- Card 3 -->
                    <td width="33.33%" valign="top" style="padding:8px;">
                      <div style="
                        border-radius:18px;
                        background:linear-gradient(145deg,#020617,#020617 45%,#111827 100%);
                        border:1px solid rgba(244,114,182,0.6);
                        padding:14px 12px;
                        height:100%;
                      ">
                        <div style="font-size:20px; margin-bottom:6px;">⚡</div>
                        <div style="font-size:13px; font-weight:600; color:#f9fafb; margin-bottom:4px;">
                          Next best steps
                        </div>
                        <div style="font-size:12px; line-height:1.6; color:#9ca3af;">
                          Get suggestions you can act on today to keep things moving in the right direction.
                        </div>
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- CTA -->
            <tr>
              <td style="padding:10px 32px 22px; background:#020617;">
                <p style="margin:0 0 14px; font-size:14px; line-height:1.6; color:#d1d5db;">
                  When you’re ready, jump back into your Aervo dashboard and explore the sample view we’ve set up for you.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td>
                      <a href="${appUrl}"
                        style="display:inline-block; padding:12px 26px; border-radius:999px;
                               background:linear-gradient(135deg,#38bdf8,#6366f1,#f97316);
                               color:#0b1020; font-size:14px; font-weight:700; text-decoration:none;
                               box-shadow:0 16px 40px rgba(56,189,248,0.45);">
                        Open your Aervo dashboard →
                      </a>
                    </td>
                    <td style="padding-left:12px; font-size:12px; color:#9ca3af;">
                      or visit <a href="${appUrl}" style="color:#93c5fd; text-decoration:none;">aervoapp.com</a> anytime.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- FOOTER -->
            <tr>
              <td style="padding:16px 32px 22px; background:#020617; border-top:1px solid #111827; font-size:11px; color:#6b7280;">
                <p style="margin:0 0 4px;">
                  You’re receiving this email because an Aervo workspace was created for <span style="color:#e5e7eb;">${safeCompany}</span>.
                </p>
                <p style="margin:0 0 4px;">
                  If this wasn’t you, please email <a href="mailto:support@aervoapp.com" style="color:#93c5fd; text-decoration:none;">support@aervoapp.com</a> and we’ll take a look.
                </p>
                <p style="margin:10px 0 0; color:#4b5563;">
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
    subject: `Welcome to Aervo, ${companyName || "your new command center"}`,
    html,
  });
}

  await sgMail.send({
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: `Welcome to Aervo, ${safeCompany}`,
    html,
  });
}

// ============= RESET PASSWORD EMAIL (AERVO THEME) =============
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

// Quick test endpoint for welcome email
app.get("/api/test-email", async (req, res) => {
  const to = req.query.to || process.env.TEST_EMAIL;

  try {
    await sendWelcomeEmail({
      toEmail: to,
      companyName: "Aervo Test Company",
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

    // 6) Send welcome email in background
    sendWelcomeEmail({
      toEmail: normalizedEmail,
      companyName,
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