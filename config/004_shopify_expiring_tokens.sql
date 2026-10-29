-- ============================================================
-- Aervo Shopify — expiring offline access tokens
-- Run this in pgAdmin4 Query Tool BEFORE deploying the code that uses it.
--
-- Shopify requires expiring offline tokens for public apps by 2027-01-01:
-- access tokens last 60 minutes, refresh tokens ~90 days, and every refresh
-- returns a NEW pair. utils/shopifyToken.js keeps these columns current.
--
-- shops.access_token and shopify_refresh_token hold AES-256-GCM ciphertext
-- (same scheme and AERVO_API_SECRET key as Square). A token stored before
-- this change is still read as plain text until the store reconnects.
-- Nothing is dropped or renamed.
-- ============================================================

ALTER TABLE shops ADD COLUMN IF NOT EXISTS shopify_refresh_token            TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS shopify_token_expires_at         TIMESTAMPTZ;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS shopify_refresh_token_expires_at TIMESTAMPTZ;

-- Set when a refresh fails (refresh token expired/revoked); cleared when the
-- merchant reconnects through OAuth.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS shopify_needs_reconnect BOOLEAN NOT NULL DEFAULT false;
