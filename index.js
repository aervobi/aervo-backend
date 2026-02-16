require("dotenv").config();
// Initialize Shopify context if env present
require("./utils/shopify");
const { createVerifyToken } = require("./utils/emailVerify");
console.log("APP_URL =", process.env.APP_URL);

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const {
  initSendgrid,
  sendWelcomeEmail,
  sendVerifyEmail,
  sendPasswordResetEmail,
} = require("./utils/email");

// ============= EXPRESS + DB SETUP =============
const app = express();
app.set("trust proxy", 1);
app.use(cors());

// Skip JSON parsing for Shopify webhooks so express.raw() can verify HMAC
app.use((req, res, next) => {
  if (req.originalUrl === "/shopify/webhooks") return next();
  return express.json()(req, res, next);
});

app.use(cookieParser());

// ✅ Init SendGrid once at startup
initSendgrid();

// ============= RATE LIMITING =============
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfterSeconds = Math.ceil((15 * 60 * 1000) / 1000); // 900
    res.set("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      success: false,
      code: "RATE_LIMITED",
      message: "Aervo Shield is on. Too many attempts from this device.",
      hint: "Wait a minute and try again. If you're stuck, use 'Forgot password.'",
      retryAfterSeconds,
    });
  },
});

const isHostedDb =
  process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isHostedDb ? { rejectUnauthorized: false } : false,
});

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_key_change_me";

// ============= JWT MIDDLEWARE =============
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: "Invalid or expired token",
      });
    }
    req.user = user;
    next();
  });
}

// Ensure Shopify tables exist, then mount Shopify routes
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id SERIAL PRIMARY KEY,
        shop_origin TEXT UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        scope TEXT,
        installed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS shopify_oauth_states (
        id SERIAL PRIMARY KEY,
        shop_origin TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log("✅ Shopify tables ensured");
  } catch (err) {
    console.error("❌ Failed to ensure Shopify tables:", err);
  }
})();

const shopifyRouter = require("./routes/shopify")(pool);
app.use("/auth/shopify", shopifyRouter);

// ============= HEALTH CHECK =============
app.get("/", (req, res) => {
  res.send("Aervo backend is running!");
});

// ============= GET CURRENT USER =============
app.get("/api/user/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, company_name, role, email_verified, created_at, last_login
       FROM users
       WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = result.rows[0];

    // Check if user has a connected Shopify shop
    const shopResult = await pool.query(
      `SELECT shop_origin, installed_at FROM shops LIMIT 1`
    );

    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        companyName: user.company_name,
        role: user.role,
        emailVerified: user.email_verified,
        createdAt: user.created_at,
        lastLogin: user.last_login,
      },
      shop: shopResult.rows.length > 0 ? {
        shopOrigin: shopResult.rows[0].shop_origin,
        installedAt: shopResult.rows[0].installed_at,
      } : null,
    });
  } catch (err) {
    console.error("Get user error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user data",
    });
  }
});

// ============= INSIGHTS (DASHBOARD DATA) =============
app.get("/insights", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) {
      return res.status(400).json({ success: false, message: "Missing shop" });
    }

    // Get access token for this shop from DB
    const dbRes = await pool.query(
      "SELECT access_token FROM shops WHERE shop_origin = $1",
      [shop]
    );

    if (dbRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Shop not found in database. Reinstall may be required.",
      });
    }

    const accessToken = dbRes.rows[0].access_token;

    const apiVersion = process.env.SHOPIFY_API_VERSION || "2024-01";
    const baseUrl = `https://${shop}/admin/api/${apiVersion}`;

    // Basic checks: fetch shop + recent orders (edit endpoints to match your UI)
    const [shopResp, ordersResp] = await Promise.all([
      fetch(`${baseUrl}/shop.json`, {
        headers: { "X-Shopify-Access-Token": accessToken },
      }),
      fetch(`${baseUrl}/orders.json?status=any&limit=10`, {
        headers: { "X-Shopify-Access-Token": accessToken },
      }),
    ]);

    if (!shopResp.ok) {
      const txt = await shopResp.text();
      return res.status(shopResp.status).json({
        success: false,
        message: "Shopify API shop.json failed",
        details: txt,
      });
    }

    if (!ordersResp.ok) {
      const txt = await ordersResp.text();
      return res.status(ordersResp.status).json({
        success: false,
        message: "Shopify API orders.json failed",
        details: txt,
      });
    }

    const shopJson = await shopResp.json();
    const ordersJson = await ordersResp.json();

    return res.json({
      success: true,
      shopName: shopJson.shop?.name || null,
      recentOrders: ordersJson.orders || [],
    });
  } catch (err) {
    console.error("Insights error:", err);
    return res.status(500).json({ success: false, message: "Insights failed" });
  }
});

// ============= TEST EMAIL =============
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
app.post("/api/signup", authLimiter, async (req, res) => {
  try {
    const { email, password, companyName } = req.body;

    if (!email || !password || !companyName) {
      return res.status(400).json({
        success: false,
        message: "Email, password, and company name are required.",
      });
    }

    const normalizedEmail = String(email).toLowerCase();

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

    // Password hash
    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Verification token + expiry (store hash in DB, email raw token)
    const { token: verifyToken, tokenHash } = createVerifyToken();
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const insertResult = await pool.query(
      `
        INSERT INTO users (
          email,
          password_hash,
          company_name,
          role,
          email_verified,
          verify_token_hash,
          verify_expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, email, company_name, role
      `,
      [
        normalizedEmail,
        passwordHash,
        companyName,
        "Owner",
        false,
        tokenHash,
        verifyExpiresAt,
      ]
    );

    const user = insertResult.rows[0];

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // ✅ Send verify email (don't block signup response)
    sendVerifyEmail({
      toEmail: normalizedEmail,
      token: verifyToken,
    }).catch((err) => console.error("Verify email failed:", err));

    return res.json({
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

// ============= VERIFY EMAIL =============
app.get("/api/verify-email", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    const normalizedEmail = String(req.query.email || "").toLowerCase();

    if (!token || !normalizedEmail) {
      return res.status(400).send("Invalid verification link.");
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const result = await pool.query(
      `
        SELECT id, email_verified, verify_expires_at, company_name
        FROM users
        WHERE email = $1
          AND verify_token_hash = $2
      `,
      [normalizedEmail, tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).send("Invalid or expired verification link.");
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return res.redirect("https://aervoapp.com/login.html?verified=1");
    }

    if (user.verify_expires_at && new Date(user.verify_expires_at) < new Date()) {
      return res.status(400).send("Verification link expired.");
    }

    await pool.query(
      `
        UPDATE users
        SET email_verified = TRUE,
            verify_token_hash = NULL,
            verify_expires_at = NULL
        WHERE id = $1
      `,
      [user.id]
    );

    // ✅ Welcome email after verification
    sendWelcomeEmail({
      toEmail: normalizedEmail,
      companyName: user.company_name,
    }).catch((err) => console.error("Welcome email failed:", err));

    return res.redirect("https://aervoapp.com/login.html?verified=1");
  } catch (err) {
    console.error("Verify email error:", err);
    return res.status(500).send("Verification failed.");
  }
});

// ============= LOGIN =============
app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    const normalizedEmail = String(email).toLowerCase();

    const result = await pool.query(
      "SELECT id, email, password_hash, company_name, role, email_verified FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials.",
      });
    }

    const user = result.rows[0];

    // ✅ Block unverified users
    if (!user.email_verified) {
      return res.status(403).json({
        success: false,
        message: "Please verify your email before logging in.",
      });
    }

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

    return res.json({
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
app.post("/api/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email is required.",
    });
  }

  try {
    const normalizedEmail = String(email).toLowerCase();

    const result = await pool.query(
      "SELECT id, email, company_name FROM users WHERE email = $1",
      [normalizedEmail]
    );

    // Always return same message (prevents account enumeration)
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

    return res.json({
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
app.post("/api/reset-password", authLimiter, async (req, res) => {
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

    return res.json({
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