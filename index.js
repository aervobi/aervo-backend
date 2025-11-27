const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== POSTGRES POOL (Render + local) =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// ===== JWT SECRET =====
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_key_change_me";

// ===== EMAIL TRANSPORT (Google Workspace / SMTP) =====
// Make sure these exist on Render:
// EMAIL_HOST=smtp.gmail.com
// EMAIL_PORT=587
// EMAIL_USER=no-reply@aervoapp.com
// EMAIL_PASS=<your app password, no spaces>
// EMAIL_FROM="Aervo <no-reply@aervoapp.com>"
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ===== WELCOME EMAIL HELPER =====
async function sendWelcomeEmail(toEmail, companyName) {
  if (!process.env.EMAIL_FROM) {
    console.warn("EMAIL_FROM not set — skipping welcome email.");
    return;
  }

  const safeName = companyName || "there";

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
            Welcome to Aervo, ${safeName} 👋
          </h1>
          <p style="margin:12px 0 0;font-size:15px;color:#9ca7d6;line-height:1.7;">
            We're excited to have you here. Aervo helps you understand your business faster through clean dashboards, simple insights, and smart AI answers.
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
              Track revenue, trends, products, and customer behavior — all in one place.
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
          <a href="https://aervoapp.com/dashboard.html"
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

  console.log("Attempting welcome email to", toEmail);

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: toEmail,
    subject: "Welcome to Aervo",
    html,
  });

  console.log("Welcome email sent to", toEmail);
}

// ===== BASIC HEALTH CHECKS =====
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

// ===== SIGNUP =====
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

    // 3) Insert user into database
    const insertResult = await pool.query(
      `
      INSERT INTO users (email, password_hash, company_name, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email, company_name, role
      `,
      [normalizedEmail, passwordHash, companyName, "Owner"]
    );

    const user = insertResult.rows[0];

    // 4) Send welcome email (don't block signup if it fails)
    try {
      await sendWelcomeEmail(user.email, user.company_name);
    } catch (emailErr) {
      console.error("Welcome email failed:", emailErr);
    }

    // 5) Create JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 6) Return response
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

// ===== LOGIN =====
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

// ===== START SERVER =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});