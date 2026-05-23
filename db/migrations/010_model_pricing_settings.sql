-- 010_model_pricing_settings — Per-model token cost settings
--
-- Stores user-editable token pricing per exact (provider, model_id).
-- When a token record is ingested for an unknown model, a row is
-- auto-created with default cost_* values of 0.
--
-- Costs are stored as USD per 1,000 tokens (decimal). For example:
--   cost_per_input_token  = 0.003  → $0.003 per 1K input tokens (Claude Haiku)
--   cost_per_output_token = 0.015  → $0.015 per 1K output tokens (Claude Haiku)

CREATE TABLE IF NOT EXISTS model_pricing_settings (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model_id      TEXT NOT NULL,

  -- Cost per 1,000 tokens, in USD (decimal)
  cost_per_input_token       NUMERIC(12,8) NOT NULL DEFAULT 0,
  cost_per_output_token      NUMERIC(12,8) NOT NULL DEFAULT 0,
  cost_per_cache_read_token  NUMERIC(12,8) DEFAULT 0,
  cost_per_cache_write_token NUMERIC(12,8) DEFAULT 0,

  -- Notes / label (user-editable description)
  label         TEXT,

  -- Whether this row was auto-created (default 0) vs. explicitly set
  is_default    BOOLEAN NOT NULL DEFAULT true,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint: one pricing row per (company, provider, model)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_settings_unique
  ON model_pricing_settings (company_id, provider, model_id);

-- Index for listing by company
CREATE INDEX IF NOT EXISTS idx_pricing_settings_company
  ON model_pricing_settings (company_id, updated_at DESC);

-- Index for looking up a specific model
CREATE INDEX IF NOT EXISTS idx_pricing_settings_model
  ON model_pricing_settings (company_id, provider, model_id);
