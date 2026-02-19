-- ============================================================
-- Aervo — Square Integration Database Schema
-- Migration: 001_square_integration.sql
-- ============================================================
-- Run with: psql $DATABASE_URL -f 001_square_integration.sql

-- ── Merchant Connections ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS square_connections (
  id                  SERIAL PRIMARY KEY,
  aervo_merchant_id   TEXT NOT NULL UNIQUE,
  square_merchant_id  TEXT NOT NULL,
  access_token_enc    TEXT NOT NULL,           -- AES-256-GCM encrypted
  refresh_token_enc   TEXT NOT NULL,           -- AES-256-GCM encrypted
  expires_at          TIMESTAMPTZ NOT NULL,
  token_type          TEXT DEFAULT 'bearer',
  scopes              TEXT,
  sync_status         TEXT,                    -- 'pending' | 'success' | 'error'
  sync_completed_at   TIMESTAMPTZ,
  sync_error          TEXT,
  connected_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Locations ─────────────────────────────────────────────────────────────────
-- One merchant can have many locations (restaurant chain, salon franchise, etc.)
CREATE TABLE IF NOT EXISTS square_locations (
  id                    SERIAL PRIMARY KEY,
  aervo_merchant_id     TEXT NOT NULL,
  square_location_id    TEXT NOT NULL UNIQUE,
  name                  TEXT,
  address               TEXT,
  city                  TEXT,
  state                 TEXT,
  postal_code           TEXT,
  country               TEXT DEFAULT 'US',
  timezone              TEXT,
  business_type         TEXT,                  -- 'PHYSICAL' | 'MOBILE'
  phone_number          TEXT,
  business_hours        JSONB,
  currency              TEXT DEFAULT 'USD',
  raw_data              JSONB,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_square_locations_merchant
  ON square_locations(aervo_merchant_id);

-- ── Orders ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS square_orders (
  id                    SERIAL PRIMARY KEY,
  square_order_id       TEXT NOT NULL UNIQUE,
  aervo_merchant_id     TEXT NOT NULL,
  square_location_id    TEXT NOT NULL,
  square_customer_id    TEXT,                  -- Nullable (anonymous transactions)
  state                 TEXT,                  -- 'COMPLETED' | 'CANCELED' | 'OPEN'
  total_amount          BIGINT,                -- In smallest currency unit (cents)
  total_tax             BIGINT,
  total_discount        BIGINT,
  currency              TEXT DEFAULT 'USD',
  source_name           TEXT,                  -- 'POS' | 'ONLINE' | app name
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  raw_data              JSONB
);
CREATE INDEX IF NOT EXISTS idx_square_orders_merchant
  ON square_orders(aervo_merchant_id);
CREATE INDEX IF NOT EXISTS idx_square_orders_location
  ON square_orders(square_location_id);
CREATE INDEX IF NOT EXISTS idx_square_orders_customer
  ON square_orders(square_customer_id);
CREATE INDEX IF NOT EXISTS idx_square_orders_created_at
  ON square_orders(created_at DESC);

-- ── Order Line Items ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS square_order_line_items (
  id                    SERIAL PRIMARY KEY,
  square_order_id       TEXT NOT NULL REFERENCES square_orders(square_order_id) ON DELETE CASCADE,
  aervo_merchant_id     TEXT NOT NULL,
  catalog_object_id     TEXT,                  -- Links to square_catalog_items
  name                  TEXT NOT NULL,
  quantity              NUMERIC NOT NULL,
  base_price            BIGINT,
  gross_amount          BIGINT,
  variation_name        TEXT,
  note                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_square_line_items_order
  ON square_order_line_items(square_order_id);
CREATE INDEX IF NOT EXISTS idx_square_line_items_catalog
  ON square_order_line_items(catalog_object_id);

-- ── Customers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS square_customers (
  id                    SERIAL PRIMARY KEY,
  square_customer_id    TEXT NOT NULL UNIQUE,
  aervo_merchant_id     TEXT NOT NULL,
  given_name            TEXT,
  family_name           TEXT,
  email_address         TEXT,
  phone_number          TEXT,
  birthday              TEXT,
  address               JSONB,
  note                  TEXT,
  reference_id          TEXT,
  creation_source       TEXT,
  total_visit_count     INTEGER DEFAULT 0,
  -- Aervo-computed fields
  aervo_segment         TEXT,                  -- 'loyal' | 'at_risk' | 'lapsed' | 'new'
  aervo_ltv_cents       BIGINT,               -- Computed lifetime value
  is_deleted            BOOLEAN DEFAULT FALSE,
  raw_data              JSONB,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_square_customers_merchant
  ON square_customers(aervo_merchant_id);
CREATE INDEX IF NOT EXISTS idx_square_customers_email
  ON square_customers(email_address);
CREATE INDEX IF NOT EXISTS idx_square_customers_segment
  ON square_customers(aervo_merchant_id, aervo_segment);

-- ── Catalog Items ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS square_catalog_items (
  id                      SERIAL PRIMARY KEY,
  square_catalog_id       TEXT NOT NULL UNIQUE,
  aervo_merchant_id       TEXT NOT NULL,
  type                    TEXT,                -- 'ITEM' | 'CATEGORY' | 'ITEM_VARIATION'
  name                    TEXT,
  description             TEXT,
  base_price_cents        BIGINT,
  category_id             TEXT,
  available_online        BOOLEAN DEFAULT FALSE,
  available_at_locations  JSONB,
  is_deleted              BOOLEAN DEFAULT FALSE,
  raw_data                JSONB,
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_square_catalog_merchant
  ON square_catalog_items(aervo_merchant_id, type);

-- ── Appointments ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS square_appointments (
  id                        SERIAL PRIMARY KEY,
  square_booking_id         TEXT NOT NULL UNIQUE,
  aervo_merchant_id         TEXT NOT NULL,
  square_location_id        TEXT,
  square_customer_id        TEXT,
  customer_note             TEXT,
  team_member_id            TEXT,              -- Staff member
  service_variation_id      TEXT,              -- What service was booked
  service_variation_version BIGINT,
  duration_minutes          INTEGER,
  status                    TEXT,              -- 'ACCEPTED' | 'CANCELLED' | 'NO_SHOW'
  no_show                   BOOLEAN DEFAULT FALSE,
  start_at                  TIMESTAMPTZ,
  source                    TEXT,
  raw_data                  JSONB,
  created_at                TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_square_appts_merchant
  ON square_appointments(aervo_merchant_id);
CREATE INDEX IF NOT EXISTS idx_square_appts_customer
  ON square_appointments(square_customer_id);
CREATE INDEX IF NOT EXISTS idx_square_appts_team_member
  ON square_appointments(team_member_id);
CREATE INDEX IF NOT EXISTS idx_square_appts_start
  ON square_appointments(start_at DESC);
