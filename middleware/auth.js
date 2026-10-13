// Single source of truth for "who is logged in".
//
// Every route that touches a user's data must use authenticateToken and take
// the owner's identity from req.user (set from the verified session), never
// from the request body, query string or URL.
//
// Sessions
//  - A signed JWT carrying { userId, email, tv }. `tv` is the user's
//    token_version at sign time; bumping that column (logout, password change or
//    reset, account deletion) invalidates every session issued before it.
//  - Browsers hold the JWT in an httpOnly cookie (JavaScript, and therefore any
//    injected script, can't read it). Non-browser / embedded-in-Shopify clients
//    can still send it as "Authorization: Bearer".
//  - Cookie sessions are protected against CSRF by SameSite=Lax plus an Origin
//    allow-list check on every state-changing request.
const jwt = require("jsonwebtoken");

const isProd = process.env.NODE_ENV === "production" || !!process.env.RENDER;

// Fail closed: a missing secret in production would silently fall back to a
// value that is public in this repo and let anyone mint valid tokens.
const JWT_SECRET = process.env.JWT_SECRET || (isProd ? null : "dev_secret_key_change_me");
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production");
}

const COOKIE_NAME = "aervo_session";
const SESSION_DAYS = 7;
const ALLOWED_ORIGINS = [
  "https://aervoapp.com",
  "https://www.aervoapp.com",
  "https://admin.shopify.com",
];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ── token_version bootstrap ───────────────────────────────────────────────────
let versioning = true;
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));

let initStarted = false;
async function initAuth(pool) {
  if (initStarted) return ready;
  initStarted = true;
  try {
    await pool.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0"
    );
  } catch (err) {
    versioning = false;
    console.error("token_version column unavailable - session revocation DISABLED:", err.message);
  } finally {
    readyResolve();
  }
}

// ── sign / cookie helpers ─────────────────────────────────────────────────────
function signSession(user, { expiresIn = `${SESSION_DAYS}d` } = {}) {
  return jwt.sign(
    { userId: user.id, email: user.email, tv: user.token_version || 0 },
    JWT_SECRET,
    { expiresIn, algorithm: "HS256" }
  );
}

const cookieBase = () => ({ httpOnly: true, secure: isProd, sameSite: "lax", path: "/" });

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    ...cookieBase(),
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieBase());
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function verify(token) {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

// Invalidate every session this user has, on every device.
async function revokeSessions(pool, userId) {
  if (!versioning) return null;
  const r = await pool.query(
    "UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version",
    [userId]
  );
  return r.rows[0] ? r.rows[0].token_version : null;
}

// ── the middleware ────────────────────────────────────────────────────────────
async function authenticateToken(req, res, next) {
  const cookieToken = readCookie(req, COOKIE_NAME);
  const authHeader = req.headers["authorization"];
  const bearer = authHeader && authHeader.split(" ")[1];

  if (!cookieToken && !bearer) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }

  // Cookie first; fall back to the Bearer token if the cookie is missing or bad
  let payload = null;
  let viaCookie = false;
  if (cookieToken && (payload = verify(cookieToken))) viaCookie = true;
  else if (bearer) payload = verify(bearer);

  if (!payload) {
    return res.status(403).json({ success: false, message: "Invalid or expired token" });
  }

  // CSRF: a cookie is sent automatically by the browser, so state-changing
  // requests must come from our own site.
  if (viaCookie && !SAFE_METHODS.has(req.method)) {
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      return res.status(403).json({ success: false, message: "Cross-site request blocked" });
    }
  }

  // Revocation: the user must still exist and the session must be current
  const pool = req.app && req.app.locals && req.app.locals.pool;
  if (pool) {
    initAuth(pool); // no-op after the first call; guarantees the column exists
    await ready;
    if (versioning) {
      try {
        const r = await pool.query("SELECT token_version FROM users WHERE id = $1", [payload.userId]);
        if (r.rows.length === 0 || (r.rows[0].token_version || 0) !== (payload.tv || 0)) {
          return res
            .status(401)
            .json({ success: false, code: "SESSION_ENDED", message: "Session ended. Please log in again." });
        }
      } catch (err) {
        console.error("Session check failed:", err.message);
        return res.status(503).json({ success: false, message: "Service temporarily unavailable" });
      }
    }
  }

  req.user = payload;
  req.authViaCookie = viaCookie;
  next();
}

// The merchant id used by the Square and AI tables is the Aervo user id as text.
function ownMerchantId(req) {
  return String(req.user.userId);
}

// Rejects a client-supplied id that isn't the caller's own. Returns true if it
// already sent a 403 (caller should stop).
function rejectForeignId(req, res, supplied) {
  if (supplied === undefined || supplied === null || supplied === "") return false;
  if (String(supplied) === String(req.user.userId)) return false;
  res.status(403).json({ success: false, message: "Access denied" });
  return true;
}

module.exports = {
  authenticateToken,
  JWT_SECRET,
  COOKIE_NAME,
  ALLOWED_ORIGINS,
  initAuth,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  readCookie,
  verifyToken: verify,
  revokeSessions,
  ownMerchantId,
  rejectForeignId,
  isProd,
};
