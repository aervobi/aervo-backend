// Single source of truth for "who is logged in".
//
// Every route that touches a user's data must use authenticateToken and take
// the owner's identity from req.user (set from the verified session), never
// from the request body, query string or URL.
//
// Sessions
//  - A signed JWT carrying { userId, email, tv, auth_at }. `tv` is the user's
//    token_version at sign time; bumping that column (logout, password change or
//    reset, account deletion) invalidates every session issued before it.
//    `auth_at` is when the person originally signed in (kept across renewals).
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
const CHALLENGE_COOKIE = "aervo_2fa";

// Sessions expire after this much INACTIVITY (the cookie is renewed only when the
// person is actually using the app: see POST /api/session/ping), and never live
// longer than the absolute cap however active they are.
const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES) || 30;
const ABSOLUTE_DAYS = Number(process.env.SESSION_MAX_DAYS) || 7;
const CHALLENGE_MINUTES = 5; // time allowed to enter a two-step code after the password
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
function signSession(user, { expiresIn = `${IDLE_MINUTES}m`, authAt } = {}) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      tv: user.token_version || 0,
      auth_at: authAt || Math.floor(Date.now() / 1000),
    },
    JWT_SECRET,
    { expiresIn, algorithm: "HS256" }
  );
}

const cookieBase = () => ({ httpOnly: true, secure: isProd, sameSite: "lax", path: "/" });

function setSessionCookie(res, token) {
  // Rolling: the browser drops the cookie after IDLE_MINUTES unless it is renewed
  res.cookie(COOKIE_NAME, token, { ...cookieBase(), maxAge: IDLE_MINUTES * 60 * 1000 });
}

// Sign a person in (browser): short idle-length token in an httpOnly cookie.
function startSession(res, user, opts) {
  setSessionCookie(res, signSession(user, opts));
}

// Renew an existing session for another idle window, keeping its original
// sign-in time so the absolute cap still applies.
function renewSession(res, payload) {
  startSession(
    res,
    { id: payload.userId, email: payload.email, token_version: payload.tv || 0 },
    { authAt: payload.auth_at || Math.floor(Date.now() / 1000) }
  );
}

// ── two-step verification challenge ──────────────────────────────────────────
// After the password (or Google / Shopify) check succeeds for an account that has
// two-step verification on, we do NOT start a session. We hand the browser a
// short-lived challenge cookie; only a valid code turns it into a session.
function startChallenge(res, user) {
  const token = jwt.sign(
    { purpose: "2fa", userId: user.id, tv: user.token_version || 0 },
    JWT_SECRET,
    { expiresIn: `${CHALLENGE_MINUTES}m`, algorithm: "HS256" }
  );
  res.cookie(CHALLENGE_COOKIE, token, {
    ...cookieBase(),
    maxAge: CHALLENGE_MINUTES * 60 * 1000,
  });
}

function readChallenge(req) {
  const p = verify(readCookie(req, CHALLENGE_COOKIE) || "");
  return p && p.purpose === "2fa" ? p : null;
}

function clearChallenge(res) {
  res.clearCookie(CHALLENGE_COOKIE, cookieBase());
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

  // Absolute cap, however active the person has been
  const ageSec = Math.floor(Date.now() / 1000) - (payload.auth_at || payload.iat || 0);
  if (payload.auth_at && ageSec > ABSOLUTE_DAYS * 86400) {
    return res
      .status(401)
      .json({ success: false, code: "SESSION_ENDED", message: "Session expired. Please log in again." });
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

  // Supervisor "view store": a request marked X-Aervo-View-Store reads the team
  // owner's store data instead of the caller's, if the owner allowed it
  // (team_members.can_view_store) and it is a read-only page on STORE_VIEW_PATHS.
  if (req.headers[STORE_VIEW_HEADER]) {
    const owner = pool && (await storeViewOwner(pool, payload.userId, req));
    if (!owner) {
      return res.status(403).json({ success: false, code: "VIEW_ONLY", message: "You can view the store's dashboard, but not change anything." });
    }
    req.user = { ...payload, userId: owner, viewerId: payload.userId, viewOnly: true };
    req.authViaCookie = viaCookie;
    require("../utils/aiSpend").enterRequest(owner, req.originalUrl);
    return next();
  }

  req.user = payload;
  req.authViaCookie = viaCookie;
  // AI calls made while handling this request are this account's spend
  require("../utils/aiSpend").enterRequest(payload.userId, req.originalUrl);
  next();
}

// ── supervisor store view ────────────────────────────────────────────────────
// Read-only endpoints the store dashboards load. Anything not listed (writes, AI,
// billing, settings, integrations, team) is refused in view mode.
const STORE_VIEW_HEADER = "x-aervo-view-store";
const STORE_VIEW_PATHS = [
  /^\/api\/user\/me$/,
  /^\/api\/ims(\/(products|customers|sales|expenses|inventory\/low-stock|analytics\/summary))?\/?$/,
  /^\/integrations\/square\/(status|orders|appointments|customers\/enriched|locations|top-items)\/?$/,
  /^\/api\/shopify\/(overview|orders|customers|inventory)\/?$/,
  /^\/api\/health-score\/?$/,
  /^\/api\/google-reviews\/?$/,
];

// The owner's user id if `viewerId` may view their store for this request, else null
async function storeViewOwner(pool, viewerId, req) {
  if (req.method !== "GET") return null;
  const path = (req.originalUrl || "").split("?")[0];
  if (!STORE_VIEW_PATHS.some((re) => re.test(path))) return null;
  try {
    const r = await pool.query(
      `SELECT t.owner_user_id FROM team_members tm JOIN teams t ON t.id = tm.team_id
        WHERE tm.user_id = $1 AND tm.role = 'supervisor' AND tm.can_view_store = TRUE`,
      [viewerId]
    );
    return r.rows[0] ? r.rows[0].owner_user_id : null;
  } catch {
    return null; // team tables missing: fail closed
  }
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
  IDLE_MINUTES,
  startSession,
  renewSession,
  startChallenge,
  readChallenge,
  clearChallenge,
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
  STORE_VIEW_HEADER,
};
