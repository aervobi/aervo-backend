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

// ============= WELCOME EMAIL =============
async function sendWelcomeEmail({ toEmail, companyName }) {
  const appUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";

  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Welcome to Aervo</title>
  </head>
  <body style="margin:0;padding:0;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">

    <div style="padding:32px 16px;background:#020617;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;border-radius:20px;overflow:hidden;background:#020617;border:1px solid #111827;">
        <!-- HERO HEADER WITH BIRD -->
        <tr>
          <td style="padding:32px; background:#020617; position:relative;">

            <!-- Big bird behind text -->
            <img
              src="https://aervoapp.com/logo.png"
              alt="Aervo"
              style="
                position:absolute;
                right:28px;
                top:20px;
                height:110px;
                opacity:0.12;
                pointer-events:none;
              "
            />

            <!-- Foreground content -->
            <div style="position:relative; z-index:2;">
              <!-- Small brand row -->
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px;">
                <img src="https://aervoapp.com/logo.png" alt="Aervo" style="height:26px;display:block;" />
                <span style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#9ca3af;">
                  Aervo
                </span>
              </div>

              <h1 style="margin:0 0 10px;font-size:26px;line-height:1.3;color:#f9fafb;">
                Welcome aboard${companyName ? `, ${companyName}` : ""} 👋
              </h1>

              <p style="margin:0;font-size:14px;line-height:1.7;color:#cbd5f5;">
                You just spun up a new command center for your business. Aervo pulls your sales,
                inventory, and customer signals into one clear view so you can see what's working
                and what needs attention in seconds.
              </p>
            </div>
          </td>
        </tr>

        <!-- VALUE + FEATURE CARDS -->
        <tr>
          <td style="padding:26px 32px 24px 32px;background:#020617;">
            <h2 style="margin:0 0 12px;font-size:17px;color:#f9fafb;">
              Here’s what Aervo is built to help you do:
            </h2>

            <ul style="margin:0 0 18px 0;padding-left:18px;font-size:14px;line-height:1.7;color:#cbd5e1;">
              <li><strong>See today at a glance</strong> – one live dashboard instead of ten tabs.</li>
              <li><strong>Ask natural questions</strong> – “How did we do this week?” or “What changed?”</li>
              <li><strong>Catch slowdowns early</strong> – spot dips in sales or low stock before they hurt you.</li>
            </ul>

            <!-- 3 feature cards in a row -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
              <tr>
                <td width="33.33%" style="padding-right:8px;">
                  <div style="border-radius:16px;background:#020617;border:1px solid #111827;padding:14px 12px;">
                    <div style="font-size:22px;margin-bottom:4px;">📊</div>
                    <div style="font-size:13px;font-weight:600;color:#e5e7eb;margin-bottom:3px;">
                      Live overview
                    </div>
                    <div style="font-size:12px;color:#9ca3af;line-height:1.5;">
                      Sales, inventory, and key metrics in one place.
                    </div>
                  </div>
                </td>

                <td width="33.33%" style="padding:0 4px;">
                  <div style="border-radius:16px;background:#020617;border:1px solid #111827;padding:14px 12px;">
                    <div style="font-size:22px;margin-bottom:4px;">💬</div>
                    <div style="font-size:13px;font-weight:600;color:#e5e7eb;margin-bottom:3px;">
                      Explain the “why”
                    </div>
                    <div style="font-size:12px;color:#9ca3af;line-height:1.5;">
                      Short explanations, not just charts and numbers.
                    </div>
                  </div>
                </td>

                <td width="33.33%" style="padding-left:8px;">
                  <div style="border-radius:16px;background:#020617;border:1px solid #111827;padding:14px 12px;">
                    <div style="font-size:22px;margin-bottom:4px;">⚡</div>
                    <div style="font-size:13px;font-weight:600;color:#e5e7eb;margin-bottom:3px;">
                      Next best steps
                    </div>
                    <div style="font-size:12px;color:#9ca3af;line-height:1.5;">
                      Suggestions you can act on today to move the needle.
                    </div>
                  </div>
                </td>
              </tr>
            </table>

            <!-- CTA -->
            <a
              href="${appUrl}"
              style="
                display:inline-block;
                padding:12px 24px;
                border-radius:999px;
                background:linear-gradient(135deg,#29c8ff,#7c5cff);
                color:#050816;
                text-decoration:none;
                font-size:14px;
                font-weight:600;
                box-shadow:0 0 18px rgba(41,200,255,0.45),0 0 32px rgba(124,92,255,0.35);
              "
            >
              Open your Aervo dashboard →
            </a>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="padding:18px 32px 22px 32px;background:#020617;border-top:1px solid #111827;text-align:center;">
            <p style="margin:0 0 4px;font-size:11px;color:#6b7280;">
              You’re receiving this because an Aervo workspace was created for ${companyName || "your business"}.
            </p>
            <p style="margin:0;font-size:11px;color:#4b5563;">
              © ${new Date().getFullYear()} Aervo. All rights reserved.
            </p>
          </td>
        </tr>
      </table>
    </div>

  </body>
  </html>
  `;

  await sgMail.send({
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: `Welcome to Aervo${companyName ? ", " + companyName : ""}`,
    html,
  });
}

// ============= RESET PASSWORD EMAIL =============
async function sendPasswordResetEmail({ toEmail, companyName, token }) {
  const baseUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const resetUrl = `${cleanBase}/reset-password.html?token=${encodeURIComponent(token)}`;

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
        <td style="padding:32px 40px;">
          <h1 style="margin:0 0 12px;font-size:22px;color:#e5ecff;font-weight:600;">
            Hi${companyName ? ` from ${companyName}` : ""} 👋
          </h1>
          <p style="margin:0 0 10px;font-size:14px;color:#d1d5db;line-height:1.7;">
            We received a request to reset your Aervo password.
          </p>
          <p style="margin:0 0 20px;font-size:14px;color:#d1d5db;line-height:1.7;">
            If this was you, click below to set a new password:
          </p>

          <a href="${resetUrl}" style="
            display:inline-block;
            padding:12px 26px;
            border-radius:999px;
            background:linear-gradient(135deg,#4f46e5,#6366f1);
            color:#fff;
            text-decoration:none;
            font-size:14px;
            font-weight:500;
            box-shadow:0 12px 30px rgba(79,70,229,0.45);
          ">
            Reset password
          </a>

          <p style="margin:18px 0 0;font-size:12px;color:#9ca3af;">
            If you didn’t request this, you can safely ignore this message.
          </p>
        </td>
      </tr>

      <tr>
        <td style="padding:18px 40px 26px;text-align:center;font-size:11px;color:#6b7280;border-top:1px solid rgba(55,65,81,0.8);">
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

// ============= HEALTH CHECK =============
app.get("/", (req, res) => {
  res.send("Aervo backend is running!");
});

// Test email endpoint
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

    // Check if user exists
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

    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const insertResult = await pool.query(
      `
        INSERT INTO users (email, password_hash, company_name, role)
        VALUES ($1, $2, $3, $4)
        RETURNING id, email, company_name, role
      `,
      [normalizedEmail, passwordHash, companyName, "Owner"]
    );

    const user = insertResult.rows[0];

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
      return res.status(401).json({
        success: false,
        message: "Invalid credentials.",
      });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials.",
      });
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

// ============= FORGOT PASSWORD =============
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

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        message: "If an account exists, we sent a reset link.",
      });
    }

    const user = result.rows[0];

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60);

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

    res.json({
      success: true,
      message: "If an account exists, we sent a reset link.",
    });

  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({
      success: false,
      message: "Something went wrong.",
    });
  }
});

// ============= RESET PASSWORD =============
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
      SELECT id, email FROM users
      WHERE reset_token = $1
        AND reset_token_expires > NOW()
      `,
      [token]
    );

    if (result.rows.length === 0) {
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

    res.json({
      success: true,
      message: "Password updated successfully.",
    });

  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({
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