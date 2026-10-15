// Time-based one-time passwords (RFC 6238 / RFC 4226): the 6-digit codes shown by
// Google Authenticator, Authy, 1Password, Microsoft Authenticator, etc.
// Implemented with Node's crypto only: HMAC-SHA1, 30-second steps, 6 digits.
const crypto = require("crypto");

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160-bit secret, the size the RFC recommends
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(keyBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", keyBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin =
    ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

function codeAt(secret, ms = Date.now()) {
  return hotp(base32Decode(secret), stepAt(ms));
}

// Accepts the current code plus one step either side (clock drift). Returns the
// matching step number (so the caller can refuse to accept it twice), or null.
function verify(secret, code, { lastStep = 0, now = Date.now() } = {}) {
  const c = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secret);
  const cur = stepAt(now);
  let hit = null;
  for (let s = cur - 1; s <= cur + 1; s++) {
    const expected = hotp(key, s);
    // compare every candidate in constant time, whatever the outcome
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c)) && s > lastStep) hit = s;
  }
  return hit;
}

// otpauth:// link that authenticator apps read from the QR code
function otpauthUri({ secret, account, issuer = "Aervo" }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { generateSecret, codeAt, verify, otpauthUri, base32Encode, base32Decode, hotp, stepAt };
