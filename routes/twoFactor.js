// Optional two-step verification with an authenticator app (Google Authenticator,
// Authy, 1Password, ...).
//
//  Turn on : POST /api/2fa/setup (secret + QR) -> POST /api/2fa/enable {code}
//            (returns one-time backup codes; every OTHER session is signed out)
//  Turn off: POST /api/2fa/disable {code}
//  Sign in : password / Google / Shopify succeed -> challenge cookie, no session
//            -> POST /api/login/2fa {code} -> session
//
// Secrets are stored encrypted. A code can be used once (replay protection), and
// each account is locked for a while after repeated wrong codes.
const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const totp = require("../utils/totp");
const {
  JWT_SECRET,
  ALLOWED_ORIGINS,
  revokeSessions,
  renewSession,
  startSession,
  readChallenge,
  clearChallenge,
} = require("../middleware/auth");

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const BACKUP_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L
const BACKUP_COUNT = 8;

// Encrypt the TOTP secret at rest. Set TOTP_ENCRYPTION_KEY in Render to keep it
// independent of JWT_SECRET (rotating JWT_SECRET would otherwise lock people out).
const KEY = crypto
  .createHash("sha256")
  .update("aervo-totp:" + (process.env.TOTP_ENCRYPTION_KEY || JWT_SECRET))
  .digest();

function enc(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("hex")).join(":");
}
function dec(blob) {
  const [iv, tag, ct] = String(blob).split(":").map((h) => Buffer.from(h, "hex"));
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const normalizeBackup = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function newBackupCodes() {
  return Array.from({ length: BACKUP_COUNT }, () => {
    let s = "";
    for (let i = 0; i < 10; i++) s += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
    return s.slice(0, 5) + "-" + s.slice(5);
  });
}

// ── failed-attempt lockout (per account, in memory) ─────────────────────────
const failures = new Map();
function lockedFor(userId) {
  const f = failures.get(String(userId));
  if (!f || f.until <= Date.now()) return 0;
  return Math.ceil((f.until - Date.now()) / 1000);
}
function recordFailure(userId) {
  const k = String(userId);
  const f = failures.get(k) || { n: 0, until: 0 };
  f.n = f.until && f.until <= Date.now() ? 1 : f.n + 1;
  if (f.n >= MAX_FAILURES) {
    f.until = Date.now() + LOCK_MS;
    f.n = 0;
  }
  failures.set(k, f);
}
const clearFailures = (userId) => failures.delete(String(userId));

function factory(pool, authenticateToken, { authLimiter } = {}) {
  const router = express.Router();
  const limiter = authLimiter || ((req, res, next) => next());

  pool
    .query(
      `ALTER TABLE users
         ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
         ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT,
         ADD COLUMN IF NOT EXISTS totp_pending_enc TEXT,
         ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT`
    )
    .catch((err) => console.error("Two-step verification columns:", err.message));

  // Checks a code for a user: authenticator code first, then a backup code.
  // Returns "totp" | "backup" | null. Never throws on a wrong code.
  async function checkSecondFactor(userId, code) {
    const r = await pool.query(
      "SELECT totp_secret_enc, totp_last_step, totp_backup_codes FROM users WHERE id = $1 AND totp_enabled = TRUE",
      [userId]
    );
    const u = r.rows[0];
    if (!u || !u.totp_secret_enc) return null;

    const step = totp.verify(dec(u.totp_secret_enc), code, { lastStep: Number(u.totp_last_step) || 0 });
    if (step) {
      // Atomic: only the first request using this step wins (blocks replays/races)
      const up = await pool.query(
        "UPDATE users SET totp_last_step = $1 WHERE id = $2 AND totp_last_step < $1",
        [step, userId]
      );
      return up.rowCount > 0 ? "totp" : null;
    }

    const normalized = normalizeBackup(code);
    if (normalized.length === 10 && u.totp_backup_codes) {
      const hashes = JSON.parse(u.totp_backup_codes);
      const h = sha(normalized);
      if (hashes.includes(h)) {
        const rest = JSON.stringify(hashes.filter((x) => x !== h));
        const up = await pool.query(
          "UPDATE users SET totp_backup_codes = $1 WHERE id = $2 AND totp_backup_codes = $3",
          [rest, userId, u.totp_backup_codes]
        );
        return up.rowCount > 0 ? "backup" : null; // each code works once
      }
    }
    return null;
  }

  // ── status ────────────────────────────────────────────────────────────────
  router.get("/api/2fa/status", authenticateToken, async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT totp_enabled, totp_backup_codes FROM users WHERE id = $1",
        [req.user.userId]
      );
      const u = r.rows[0] || {};
      res.json({
        success: true,
        enabled: !!u.totp_enabled,
        backupCodesRemaining: u.totp_backup_codes ? JSON.parse(u.totp_backup_codes).length : 0,
      });
    } catch (err) {
      console.error("2FA status error:", err.message);
      res.status(500).json({ success: false, message: "Could not load two-step verification status." });
    }
  });

  // ── begin setup: new secret + QR (not active until a code is confirmed) ──
  router.post("/api/2fa/setup", authenticateToken, async (req, res) => {
    try {
      const r = await pool.query("SELECT email, totp_enabled FROM users WHERE id = $1", [req.user.userId]);
      const u = r.rows[0];
      if (!u) return res.status(404).json({ success: false, message: "Account not found." });
      if (u.totp_enabled) {
        return res.status(409).json({ success: false, message: "Two-step verification is already on." });
      }
      const secret = totp.generateSecret();
      await pool.query("UPDATE users SET totp_pending_enc = $1 WHERE id = $2", [enc(secret), req.user.userId]);
      const uri = totp.otpauthUri({ secret, account: u.email });
      const qr = await QRCode.toString(uri, { type: "svg", margin: 1, width: 220 });
      res.json({ success: true, secret, otpauth: uri, qr });
    } catch (err) {
      console.error("2FA setup error:", err.message);
      res.status(500).json({ success: false, message: "Could not start two-step verification setup." });
    }
  });

  // ── confirm with the first code: turns it on, returns backup codes ───────
  router.post("/api/2fa/enable", authenticateToken, limiter, async (req, res) => {
    try {
      const wait = lockedFor(req.user.userId);
      if (wait) return res.status(429).json({ success: false, message: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.` });

      const r = await pool.query(
        "SELECT totp_pending_enc, totp_enabled FROM users WHERE id = $1",
        [req.user.userId]
      );
      const u = r.rows[0];
      if (!u || !u.totp_pending_enc) {
        return res.status(400).json({ success: false, message: "Start setup first." });
      }
      if (u.totp_enabled) return res.status(409).json({ success: false, message: "Already on." });

      const step = totp.verify(dec(u.totp_pending_enc), req.body && req.body.code);
      if (!step) {
        recordFailure(req.user.userId);
        return res.status(400).json({ success: false, message: "That code isn't right. Check the app and try again." });
      }
      clearFailures(req.user.userId);

      const codes = newBackupCodes();
      await pool.query(
        `UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL,
           totp_enabled = TRUE, totp_last_step = $1, totp_backup_codes = $2 WHERE id = $3`,
        [step, JSON.stringify(codes.map((c) => sha(normalizeBackup(c)))), req.user.userId]
      );

      // Turning protection on ends every OTHER session (a stolen one stops working);
      // this device stays signed in.
      const tv = await revokeSessions(pool, req.user.userId);
      if (req.authViaCookie) {
        renewSession(res, { ...req.user, tv: tv == null ? req.user.tv : tv });
      }
      res.json({ success: true, backupCodes: codes });
    } catch (err) {
      console.error("2FA enable error:", err.message);
      res.status(500).json({ success: false, message: "Could not turn on two-step verification." });
    }
  });

  // ── turn off (needs a current code) ──────────────────────────────────────
  router.post("/api/2fa/disable", authenticateToken, limiter, async (req, res) => {
    try {
      const wait = lockedFor(req.user.userId);
      if (wait) return res.status(429).json({ success: false, message: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.` });

      const ok = await checkSecondFactor(req.user.userId, req.body && req.body.code);
      if (!ok) {
        recordFailure(req.user.userId);
        return res.status(400).json({ success: false, message: "That code isn't right." });
      }
      clearFailures(req.user.userId);
      await pool.query(
        `UPDATE users SET totp_enabled = FALSE, totp_secret_enc = NULL, totp_pending_enc = NULL,
           totp_backup_codes = NULL, totp_last_step = 0 WHERE id = $1`,
        [req.user.userId]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("2FA disable error:", err.message);
      res.status(500).json({ success: false, message: "Could not turn off two-step verification." });
    }
  });

  // ── new backup codes (old ones stop working) ─────────────────────────────
  router.post("/api/2fa/backup-codes", authenticateToken, limiter, async (req, res) => {
    try {
      const wait = lockedFor(req.user.userId);
      if (wait) return res.status(429).json({ success: false, message: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.` });

      const ok = await checkSecondFactor(req.user.userId, req.body && req.body.code);
      if (!ok) {
        recordFailure(req.user.userId);
        return res.status(400).json({ success: false, message: "That code isn't right." });
      }
      clearFailures(req.user.userId);
      const codes = newBackupCodes();
      await pool.query("UPDATE users SET totp_backup_codes = $1 WHERE id = $2", [
        JSON.stringify(codes.map((c) => sha(normalizeBackup(c)))),
        req.user.userId,
      ]);
      res.json({ success: true, backupCodes: codes });
    } catch (err) {
      console.error("2FA backup codes error:", err.message);
      res.status(500).json({ success: false, message: "Could not create backup codes." });
    }
  });

  // ── sign-in step two ─────────────────────────────────────────────────────
  router.post("/api/login/2fa", limiter, async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return res.status(403).json({ success: false, message: "Cross-site request blocked" });
      }

      const challenge = readChallenge(req);
      if (!challenge) {
        return res.status(401).json({
          success: false,
          code: "CHALLENGE_EXPIRED",
          message: "That sign-in expired. Please start again.",
        });
      }

      const wait = lockedFor(challenge.userId);
      if (wait) {
        return res.status(429).json({
          success: false,
          message: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} minutes.`,
        });
      }

      const u = (
        await pool.query(
          "SELECT id, email, company_name, platform, token_version FROM users WHERE id = $1",
          [challenge.userId]
        )
      ).rows[0];
      // The challenge dies if the account changed (e.g. password reset) meanwhile
      if (!u || (u.token_version || 0) !== (challenge.tv || 0)) {
        clearChallenge(res);
        return res.status(401).json({ success: false, code: "CHALLENGE_EXPIRED", message: "That sign-in expired. Please start again." });
      }

      const method = await checkSecondFactor(u.id, req.body && req.body.code);
      if (!method) {
        recordFailure(u.id);
        return res.status(401).json({ success: false, message: "That code isn't right. Please try again." });
      }

      clearFailures(u.id);
      clearChallenge(res);
      await pool.query("UPDATE users SET last_login = NOW() WHERE id = $1", [u.id]);
      startSession(res, u);
      res.json({
        success: true,
        usedBackupCode: method === "backup",
        user: { id: u.id, email: u.email, companyName: u.company_name, platform: u.platform },
      });
    } catch (err) {
      console.error("2FA login error:", err.message);
      res.status(500).json({ success: false, message: "Could not verify the code." });
    }
  });

  return router;
}

// Does this account require a second step? A missing column (feature not set up
// yet) means no; any other database error must NOT silently skip the check.
async function requiresSecondFactor(pool, userId) {
  try {
    const r = await pool.query("SELECT totp_enabled FROM users WHERE id = $1", [userId]);
    return !!(r.rows[0] && r.rows[0].totp_enabled);
  } catch (err) {
    if (err.code === "42703") return false; // column doesn't exist
    throw err;
  }
}

module.exports = factory;
module.exports.requiresSecondFactor = requiresSecondFactor;
module.exports.__test = { enc, dec, lockedFor, recordFailure, clearFailures, MAX_FAILURES };
