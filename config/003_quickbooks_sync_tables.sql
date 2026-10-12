-- ============================================================
-- Aervo QuickBooks Integration — DB Migration (Phase 1, sync tables)
-- Run this in pgAdmin4 Query Tool
-- See quickbooks-integration-spec.md section 2 for full context.
-- ============================================================

-- 1. quickbooks_items
--    Staging copy of the QuickBooks Item (Product/Service) list, used
--    for SKU matching (product_cost_mappings) and as a direct cost
--    source when an item has PurchaseCost set. Lightly normalized —
--    raw_data keeps the full QBO payload for anything not broken out.

CREATE TABLE IF NOT EXISTS quickbooks_items (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quickbooks_item_id  TEXT NOT NULL,
  name                TEXT NOT NULL,
  sku                 TEXT,
  type                TEXT,
    -- QBO Item.Type: 'Inventory' | 'NonInventory' | 'Service' | 'Category' ...
  unit_price          NUMERIC,
  purchase_cost       NUMERIC,
    -- QBO Item.PurchaseCost, when the item has a direct cost on file
  raw_data            JSONB NOT NULL,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, quickbooks_item_id)
);

-- 2. quickbooks_purchases
--    One row per Purchase/Bill line item that references a QuickBooks
--    item — the cost source for items with no direct PurchaseCost.
--    Margin calc can average unit_cost per quickbooks_item_id.

CREATE TABLE IF NOT EXISTS quickbooks_purchases (
  id                          SERIAL PRIMARY KEY,
  user_id                     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_type            VARCHAR(20) NOT NULL CHECK (transaction_type IN ('purchase', 'bill')),
  quickbooks_transaction_id   TEXT NOT NULL,
  line_id                     TEXT NOT NULL,
    -- QBO line's own Id within the transaction (lines are re-numbered
    -- on edit, but this is stable enough between syncs of the same doc)
  quickbooks_item_id          TEXT,
    -- null for account-based expense lines (no item reference)
  txn_date                    DATE,
  quantity                    NUMERIC,
  unit_cost                   NUMERIC,
  amount                      NUMERIC NOT NULL,
  raw_data                    JSONB NOT NULL,
  synced_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, transaction_type, quickbooks_transaction_id, line_id)
);

-- 3. quickbooks_pnl_snapshots
--    Raw category-level Profit & Loss pull, one row per user per sync
--    run — the category-average fallback source for margin calc
--    (spec section 5) when a product has no matched QuickBooks item.

CREATE TABLE IF NOT EXISTS quickbooks_pnl_snapshots (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  data          JSONB NOT NULL,
    -- raw QBO ProfitAndLoss report response for the period
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, period_start, period_end)
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_quickbooks_items_user_id
  ON quickbooks_items(user_id);

CREATE INDEX IF NOT EXISTS idx_quickbooks_items_user_sku
  ON quickbooks_items(user_id, sku);

CREATE INDEX IF NOT EXISTS idx_quickbooks_purchases_user_id
  ON quickbooks_purchases(user_id);

CREATE INDEX IF NOT EXISTS idx_quickbooks_purchases_user_item
  ON quickbooks_purchases(user_id, quickbooks_item_id);

CREATE INDEX IF NOT EXISTS idx_quickbooks_pnl_snapshots_user_period
  ON quickbooks_pnl_snapshots(user_id, period_start);

-- ============================================================
-- Done. Verify with:
--   SELECT * FROM quickbooks_items LIMIT 5;
--   SELECT * FROM quickbooks_purchases LIMIT 5;
--   SELECT * FROM quickbooks_pnl_snapshots LIMIT 5;
-- ============================================================
