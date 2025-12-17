const crypto = require("crypto");

// Creates a raw token to email + a hash to store in DB
function createVerifyToken() {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = { createVerifyToken, hashToken };