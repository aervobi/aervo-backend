// utils/shopifyToken.js
// Shopify expiring offline access tokens. Access tokens last 60 minutes,
// refresh tokens ~90 days, and every refresh returns a NEW pair (the old one
// is retired), so the newest pair must always be the one saved. Every Shopify
// Admin API call gets its token from getValidShopifyToken.
//
// Both tokens are encrypted at rest with the same AES-256-GCM scheme and
// AERVO_API_SECRET key as Square (integrations/square/auth/tokenStore.js).
// A token saved before encryption is still read as plain text. Never log tokens.

const crypto = require("crypto");

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh when < 5 minutes are left

// ---- token encryption at rest (same key derivation as Square) ----
const isProd = process.env.NODE_ENV === "production" || !!process.env.RENDER;
const ENCRYPTION_KEY = (() => {
  const secret = process.env.AERVO_API_SECRET || (isProd ? "" : "aervo-dev-only-square-token-key");
  if (!secret) {
    console.error("Shopify token encryption unavailable: AERVO_API_SECRET is not set");
    return null;
  }
  const raw = Buffer.from(secret, "utf8");
  return raw.length >= 32 ? raw.subarray(0, 32) : crypto.createHash("sha256").update(raw).digest();
})();

function encryptToken(text) {
  if (!ENCRYPTION_KEY) throw new Error("AERVO_API_SECRET must be set to store Shopify tokens");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptToken(stored) {
  if (!stored) return null;
  const parts = stored.split(":");
  if (parts.length !== 3) return stored; // saved before encryption: plain text
  if (!ENCRYPTION_KEY) throw new Error("AERVO_API_SECRET must be set to read Shopify tokens");
  const [ivHex, authTagHex, encryptedHex] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]).toString("utf8");
}

// ---- errors callers can recognise by .code ----
function shopifyError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
const notConnected = (shop) =>
  shopifyError("SHOPIFY_NOT_CONNECTED", `Shopify store ${shop} is not connected.`);
const reconnectRequired = (shop) =>
  shopifyError(
    "SHOPIFY_RECONNECT_REQUIRED",
    `Aervo lost access to ${shop}. Reconnect Shopify in Integrations.`
  );

// ---- helpers ----
function expiryFrom(seconds) {
  const s = Number(seconds);
  return s > 0 ? new Date(Date.now() + s * 1000) : null;
}

// No expiry saved = a legacy non-expiring token, which is still valid as is.
function isFresh(expiresAt) {
  return !expiresAt || new Date(expiresAt).getTime() - Date.now() > REFRESH_MARGIN_MS;
}

// Encrypted columns + expiry timestamps for a Shopify token response
// (authorization-code exchange or refresh).
function tokenColumns(data) {
  return {
    accessToken: encryptToken(data.access_token),
    refreshToken: data.refresh_token ? encryptToken(data.refresh_token) : null,
    expiresAt: expiryFrom(data.expires_in),
    refreshExpiresAt: expiryFrom(data.refresh_token_expires_in),
  };
}

async function requestRefresh(shop, refreshToken, fetchImpl) {
  const r = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const err = new Error(`Shopify token refresh failed (${r.status})`);
    err.httpStatus = r.status;
    throw err;
  }
  const data = await r.json();
  if (!data.access_token || !data.refresh_token) {
    throw new Error("Shopify token refresh response missing tokens");
  }
  return data;
}

// Refresh under a row lock so two requests never spend the same refresh token.
// `rejectedToken` is the access token Shopify just answered 401 to (forced refresh).
async function refreshShopifyToken(pool, shop, { rejectedToken, fetchImpl = fetch } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (
      await client.query(
        `SELECT access_token, shopify_refresh_token, shopify_token_expires_at,
                shopify_refresh_token_expires_at, shopify_needs_reconnect
         FROM shops WHERE shop_origin = $1 FOR UPDATE`,
        [shop]
      )
    ).rows[0];
    if (!row || !row.access_token) throw notConnected(shop);
    if (row.shopify_needs_reconnect) throw reconnectRequired(shop);

    // Another request may have refreshed while this one waited for the lock
    const current = decryptToken(row.access_token);
    if (current !== rejectedToken && isFresh(row.shopify_token_expires_at)) {
      await client.query("COMMIT");
      return current;
    }

    const markReconnect = async () => {
      await client.query(`UPDATE shops SET shopify_needs_reconnect = true WHERE shop_origin = $1`, [shop]);
      await client.query("COMMIT");
      console.warn(`Shopify store ${shop} needs to be reconnected`);
      return reconnectRequired(shop);
    };

    const refreshToken = decryptToken(row.shopify_refresh_token);
    const refreshExpired =
      row.shopify_refresh_token_expires_at && new Date(row.shopify_refresh_token_expires_at) <= new Date();
    if (!refreshToken || refreshExpired) throw await markReconnect();

    let data;
    try {
      data = await requestRefresh(shop, refreshToken, fetchImpl);
    } catch (err) {
      // 400/401 = refresh token revoked/expired. Anything else (timeout, 5xx)
      // is temporary, so the store isn't flagged.
      if (err.httpStatus === 400 || err.httpStatus === 401) throw await markReconnect();
      throw err;
    }

    const c = tokenColumns(data);
    await client.query(
      `UPDATE shops SET
         access_token                     = $2,
         shopify_refresh_token            = $3,
         shopify_token_expires_at         = $4,
         shopify_refresh_token_expires_at = $5,
         shopify_needs_reconnect          = false
       WHERE shop_origin = $1`,
      [shop, c.accessToken, c.refreshToken, c.expiresAt, c.refreshExpiresAt]
    );
    await client.query("COMMIT");
    return data.access_token;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {}); // no-op after COMMIT
    throw err;
  } finally {
    client.release();
  }
}

// A usable access token for this shop, refreshed first when it's about to
// expire. Callers check that the user owns the shop before calling this.
async function getValidShopifyToken(pool, shop, { rejectedToken, fetchImpl } = {}) {
  const row = (
    await pool.query(
      `SELECT access_token, shopify_token_expires_at, shopify_needs_reconnect
       FROM shops WHERE shop_origin = $1`,
      [shop]
    )
  ).rows[0];
  if (!row || !row.access_token) throw notConnected(shop);
  if (row.shopify_needs_reconnect) throw reconnectRequired(shop);

  const token = decryptToken(row.access_token);
  if (token !== rejectedToken && isFresh(row.shopify_token_expires_at)) return token;
  return refreshShopifyToken(pool, shop, { rejectedToken, fetchImpl });
}

// fetch() for Shopify Admin API calls: on a 401, force one refresh and retry once.
// `options.headers` must carry the X-Shopify-Access-Token that was used.
async function shopifyFetch(pool, shop, url, options = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, options);
  if (res.status !== 401) return res;

  const headers = { ...(options.headers || {}) };
  const token = await getValidShopifyToken(pool, shop, {
    rejectedToken: headers["X-Shopify-Access-Token"],
    fetchImpl,
  });
  return fetchImpl(url, { ...options, headers: { ...headers, "X-Shopify-Access-Token": token } });
}

module.exports = { getValidShopifyToken, shopifyFetch, tokenColumns };
