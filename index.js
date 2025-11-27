const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

const app = express();

// ==== Middlewares ====
app.use(cors());
app.use(express.json());

// ==== Postgres pool (Render + local) ====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
});

// ==== JWT secret ====
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_key_change_me";

// ==== Email transporter (Google Workspace / SMTP) ====
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ==== Welcome email helper ====
async function sendWelcomeEmail(toEmail, companyName) {
  if (!process.env.EMAIL_FROM) {
    console.warn("EMAIL_FROM not set, skipping welcome email");
    return;
  }

  const html = `
  <div style="background-color:#050817;padding:32px 0;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#050817;color:#d6def8;">
      <tr>
        <td style="padding:16px 32px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.06);">
          <span style="display:inline-block;font-weight:600;letter-spacing:4px;font-size:13px;color:#8fbfff;">
            AERVO
          </span>
        </td>
      </tr>

      <tr>
        <td style="padding:32px 32px 12px;">
          <h1 style="margin:0 0 12px;font-size:24px;color:#e5ecff;">
            Welcome to Aervo, ${companyName || "there"} 👋
          </h1>
          <p style="margin:0;font-size:14px;color:#9ca7d6;line-height:1.6;">
            Thanks for creating your account. Aervo gives you a higher view of your business by
            pulling your data into one place and turning it into clear, actionable insights.
          </p>
        </td>
      </tr>

      <tr>
        <td style="padding:12px 32px 24px;">
          <div style="
            border-radius:16px;
            border:1px solid rgba(143,191,255,0.35);
            background:radial-gradient(circle at top left,#1a243d,#050817);
            padding:20px 18px;
          ">
            <h2 style="margin:0 0 8px;font-size:16px;color:#e5ecff;">
              A higher view of your business
            </h2>
            <p style="margin:0;font-size:13px;color:#a6b3dd;line-height:1.6;">
              See sales trends, understand performance, and spot issues early with AI-powered summaries
              tailored for busy owners.
            </p>
            <div style="margin-top:14px;">
              <span style="
                display:inline-block;
                font-size:11px;
                padding:4px 10px;
                border-radius:999px;
                border:1px solid rgba(143,191,255,0.5);
                color:#8fbfff;
                background:rgba(5,8,23,0.9);
              ">
                Live metrics • AI insights • Clean dashboards
              </span>
            </div>
          </div>
        </td>
      </tr>

      <tr>
        <td style="padding:12px 32px 8px;">
          <h3 style="margin:0 0 8px;font-size:15px;color:#e5ecff;">What you can do with Aervo</h3>
          <ul style="margin:0 0 10px 18px;padding:0;font-size:13px;color:#9ca7d6;line-height:1.7;">
            <li>Connect your tools and see key numbers in one place.</li>
            <li>Ask natural questions like “How did we do this month?” and get clear answers.</li>
            <li>Spot trends, slowdowns, and opportunities without digging through spreadsheets.</li>
          </ul>
        </td>
      </tr>

      <tr>
        <td style="padding:4px 32px 24px;">
          <a href="https://aervoapp.com/dashboard.html" style="
            display:inline-block;
            padding:10px 18px;
            border-radius:999px;
            font-size:13px;
            text-decoration:none;
            background:#1a243d;
            color:#b4cdff;
            box-shadow:0 0 12px rgba(137,180,255,0.5);
          ">
            Open your dashboard
          </a>
        </td>
      </tr>

      <tr>
        <td style="padding:16px 32px 32px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:#6c7598;">
          You’re receiving this email because you created an Aervo account.
          <br><br>
          © ${new Date().getFullYear()} Aervo. All rights reserved.
        </td>
      </tr>
    </table>
  </div>
  `;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: toEmail,
    subject: "Welcome to Aervo",
    html,
  });
}

// ==== Root health check ====
app.get("/", (req, res) => {
  res.send("Aervo backend is running!");
});

// ==== API status endpoint ====
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

/**
 * SIGNUP: create a new user account
 * POST /api/signup
 * body: { email, password, companyName }
 */
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

    // 1) Check if email already exists
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

    // 3) Insert new user
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

    // 5) Fire-and-forget welcome email
    sendWelcomeEmail(user.email, user.company_name).catch((err) =>
      console.error("Failed to send welcome email:", err)
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
    console.error("Signup error:", err);
    res.status(500).json({
      success: false,
      message: "Error creating account. Please try again.",
    });
  }
});

/**
 * LOGIN: existing user signs in
 * POST /api/login
 * body: { email, password }
 */
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required." });
    }

    const normalizedEmail = email.toLowerCase();

    // Look up user by email
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

    // Compare password
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials." });
    }

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

// ==== Start server ====
const PORT = process.env.PORT || 10000;
// ADMIN: List all users (temporary open access — later we secure it)
app.get("/api/users", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, company_name, role, created_at
       FROM users
       ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      users: result.rows
    });
  } catch (err) {
    console.error("Fetch users error:", err);
    res.status(500).json({
      success: false,
      message: "Error fetching users."
    });
  }
});
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});