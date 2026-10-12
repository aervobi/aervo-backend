// Single source of truth for "who is logged in".
//
// Every route that touches a user's data must use authenticateToken and take
// the owner's identity from req.user (set from the signed token), never from
// the request body, query string or URL.
const jwt = require("jsonwebtoken");

const isProd = process.env.NODE_ENV === "production" || !!process.env.RENDER;

// Fail closed: a missing secret in production would silently fall back to a
// value that is public in this repo and let anyone mint valid tokens.
const JWT_SECRET = process.env.JWT_SECRET || (isProd ? null : "dev_secret_key_change_me");
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production");
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }

  jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: "Invalid or expired token" });
    }
    req.user = user;
    next();
  });
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

module.exports = { authenticateToken, JWT_SECRET, ownMerchantId, rejectForeignId, isProd };
