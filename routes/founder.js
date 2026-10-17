// Founder tools: lets the people who build Aervo switch their OWN account between
// plans for free, to try each tier without paying.
//
//  - Founders are listed by email in FOUNDER_EMAILS (comma separated). The check
//    uses the signed-in account's email from the database (never the request) and
//    requires that email to be verified.
//  - Only the caller's own plan can change. There is no way to change anyone else's.
//  - A later Stripe or Shopify billing event for the account still wins, as usual.
const express = require("express");
const PLANS = require("../config/plans");

const DEFAULT_FOUNDERS = "omardavila20@gmail.com";

function founderEmails() {
  return (process.env.FOUNDER_EMAILS || DEFAULT_FOUNDERS)
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// row: { email, email_verified }
function isFounder(row) {
  return !!(row && row.email_verified && founderEmails().includes(String(row.email || "").toLowerCase()));
}

module.exports = function founderRoutes(pool, authenticateToken) {
  const router = express.Router();

  // ── POST /api/founder/plan { plan } ── switch your own plan (founders only)
  router.post("/api/founder/plan", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const plan = String(req.body?.plan || "");
      if (!Object.prototype.hasOwnProperty.call(PLANS, plan)) {
        return res.status(400).json({ success: false, message: "Unknown plan." });
      }
      const r = await pool.query("SELECT email, email_verified FROM users WHERE id = $1", [userId]);
      if (!isFounder(r.rows[0])) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      await pool.query("UPDATE users SET plan = $2 WHERE id = $1", [userId, plan]);
      console.log(`Founder plan switch: user ${userId} -> ${plan}`);
      return res.json({ success: true, plan });
    } catch (err) {
      console.error("Founder plan switch error:", err);
      return res.status(500).json({ success: false, message: "Couldn't switch plan." });
    }
  });

  return router;
};

module.exports.isFounder = isFounder;
