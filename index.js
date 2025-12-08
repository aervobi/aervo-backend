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

// Helper: send welcome email (SendGrid, Aervo themed)
async function sendWelcomeEmail(toEmail, companyName) {
  const appName = "Aervo";
  const brandUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";

  const html = `
  <div style="background:#050817;padding:40px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#0a0f2b;border-radius:14px;overflow:hidden;color:#d6def8;">
      
      <!-- Header -->
      <tr>
        <td style="padding:32px 40px;text-align:center;background:#050817;border-bottom:1px solid rgba(255,255,255,0.05);">
          <img src="https://aervoapp.com/logo.png" width="78" style="opacity:0.95;filter:drop-shadow(0 0 10px rgba(137,180,255,0.9))" alt="Aervo Logo">
          <div style="font-size:13px;letter-spacing:4px;color:#8fbfff;margin-top:8px;">AERVO</div>
        </td>
      </tr>

      <!-- Hero text -->
      <tr>
        <td style="padding:40px 40px 20px;">
          <h1 style="margin:0;font-size:26px;color:#e5ecff;font-weight:600;">
            Welcome to ${appName}, ${companyName || "there"} 👋
          </h1>
          <p style="margin:12px 0 0;font-size:15px;color:#9ca7d6;line-height:1.7;">
            Hey there, we got your sign up and your new command center is ready.
            Aervo helps you understand your business faster with clean dashboards,
            simple insights, and smart AI answers.
          </p>
        </td>
      </tr>

      <!-- Feature highlight -->
      <tr>
        <td style="padding:20px 40px;">
          <div style="
            border-radius:14px;
            border:1px solid rgba(143,191,255,0.35);
            background:radial-gradient(circle at top left,#1e2f55,#0a0f2b);
            padding:24px 22px;
            box-shadow:0 0 26px rgba(80,130,255,0.25);
          ">
            <h2 style="margin:0 0 10px;color:#e5ecff;font-size:18px;font-weight:500;">
              What you can do with Aervo
            </h2>
            <p style="margin:0;color:#a6b3dd;font-size:14px;line-height:1.7;">
              Think of Aervo as a higher view of your business. No busywork, no spreadsheets,
              just the story behind your numbers.
            </p>
            <ul style="margin:16px 0 0 20px;padding:0;color:#c2cff6;font-size:14px;line-height:1.8;">
              <li>See today’s revenue and trends at a glance</li>
              <li>Spot winning products and slow movers quickly</li>
              <li>Ask questions in plain language and get clear answers</li>
            </ul>
          </div>
        </td>
      </tr>

      <!-- CTA -->
      <tr>
        <td style="padding:10px 40px 32px;">
          <a href="${brandUrl.replace(/\/+$/, "")}/dashboard.html"
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
          <p style="margin-top:12px;font-size:12px;color:#8b94c0;">
            Or copy and paste this link into your browser:<br>
            <span style="word-break:break-all;color:#c5cff6;">
              ${brandUrl.replace(/\/+$/, "")}/dashboard.html
            </span>
          </p>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="padding:26px 40px;text-align:center;border-top:1px solid rgba(255,255,255,0.05);font-size:12px;color:#6c7598;">
          You're receiving this because an Aervo account was created with this email.<br><br>
          © ${new Date().getFullYear()} ${appName} — All rights reserved.
        </td>
      </tr>
    </table>
  </div>
  `;

  await sgMail.send({
    to: toEmail,
    from: process.env.SENDGRID_FROM_EMAIL, // e.g. no-reply@aervoapp.com
    subject: `Welcome to ${appName} 🚀`,
    html,
  });
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

    
// 6) Send Aervo Welcome Email (new HTML design)
sendWelcomeEmail({
  toEmail: normalizedEmail,
  companyName,
  userRole: user.role
}).catch((err) => console.error("Welcome email failed:", err));

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
// ================== FORGOT PASSWORD ==================
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
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour

    // Save token + expiry in the users table
    await pool.query(
      `
        UPDATE users
        SET reset_token = $1,
            reset_token_expires = $2
        WHERE id = $3
      `,
      [token, expiresAt, user.id]
    );

    // Build reset URL for the frontend
    const baseUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
    const resetLink = `${baseUrl.replace(
      /\/+$/,
      ""
    )}/reset-password.html?token=${encodeURIComponent(token)}`;

    const year = new Date().getFullYear();

    // Send Aervo-themed email with SendGrid
    await sgMail.send({
      to: user.email,
      from: process.env.SENDGRID_FROM_EMAIL, // e.g. no-reply@aervoapp.com
      subject: "Reset your Aervo password",
      html: `
        <div style="background:#050817;padding:40px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#0a0f2b;border-radius:14px;overflow:hidden;color:#d6def8;">
            
            <tr>
              <td style="padding:24px 32px;text-align:center;background:#050817;border-bottom:1px solid rgba(255,255,255,0.06);">
                <img src="https://aervoapp.com/logo.png" width="72" alt="Aervo Logo"
                  style="display:block;margin:0 auto 6px;filter:drop-shadow(0 0 10px rgba(137,180,255,0.8));">
                <div style="font-size:12px;letter-spacing:4px;color:#8fbfff;">AERVO</div>
              </td>
            </tr>

            <tr>
              <td style="padding:32px 32px 12px;">
                <h1 style="margin:0 0 8px;font-size:22px;color:#e5ecff;font-weight:600;">
                  Forgot your password?
                </h1>
                <p style="margin:0;font-size:14px;line-height:1.7;color:#9ca7d6;">
                  Hey there, we got a request to reset the password for your Aervo account
                  (<span style="color:#c2cff6;">${user.email}</span>).
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:12px 32px 8px;">
                <p style="margin:0 0 10px;font-size:14px;line-height:1.7;color:#a6b3dd;">
                  No worries, it happens. Click the button below to choose a new password
                  and get signed back into your dashboard.
                </p>
                <p style="margin:0 0 20px;">
                  <a href="${resetLink}"
                     style="display:inline-block;padding:11px 22px;border-radius:999px;
                            background:linear-gradient(135deg,#4f46e5,#7c3aed);
                            color:#ffffff;text-decoration:none;font-size:14px;
                            box-shadow:0 0 18px rgba(127,156,255,0.7);">
                    Reset your password
                  </a>
                </p>
                <p style="margin:0;font-size:12px;line-height:1.6;color:#7c86b0;">
                  This link will work for about 1 hour. After that, you can always request a new one.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 32px 8px;">
                <p style="margin:0 0 6px;font-size:13px;color:#9ca7d6;">
                  If the button doesn't work, copy and paste this link into your browser:
                </p>
                <p style="margin:0;font-size:12px;color:#c2cff6;word-break:break-all;">
                  ${resetLink}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 32px 24px;">
                <p style="margin:0;font-size:12px;line-height:1.7;color:#6c7598;">
                  Didn’t ask to reset your password? You can safely ignore this email and your
                  password will stay the same.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 32px 24px;text-align:center;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:#6c7598;">
                © ${year} Aervo · Helping you see your business from a higher view.
              </td>
            </tr>

          </table>
        </div>
      `,
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
// ================== RESET PASSWORD (DB-backed) ==================
app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Token and new password are required.",
    });
  }

  try {
    // Look up user by reset token
    const result = await pool.query(
      `
      SELECT id, email, reset_token_expires
      FROM users
      WHERE reset_token = $1
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

    // Check expiry
    if (!user.reset_token_expires || user.reset_token_expires < new Date()) {
      return res.status(400).json({
        success: false,
        message: "Reset link has expired. Please request a new one.",
      });
    }

    // Hash new password
    const hashed = await bcrypt.hash(newPassword, 10);

    // Update password and clear token
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
      message: "Something went wrong on the server.",
    });
  }
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});