-- 007_provider_cost_ledger — provider source-of-truth cost-by-model ledger

CREATE TABLE IF NOT EXISTS provider_cost_ledger (
  id TEXT PRIMARY KEY,
  company_id TEXT,                          -- Mellow company ID (nullable for backward compat)
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  amount NUMERIC(20, 6) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  tokens_input BIGINT,
  tokens_output BIGINT,
  tokens_cache_read BIGINT,
  tokens_cache_write BIGINT,
  run_count INTEGER,
  source TEXT NOT NULL CHECK (source IN ('provider_billing_api', 'paperclip_estimated', 'paperclip_usage')),
  sync_status TEXT NOT NULL DEFAULT 'fresh' CHECK (sync_status IN ('fresh', 'stale', 'unavailable', 'error')),
  last_synced_at TIMESTAMPTZ,
  sync_error TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  provider_account_label TEXT,
  estimated_input_price_per_m NUMERIC(10, 6),
  estimated_output_price_per_m NUMERIC(10, 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, provider, model_id, period_start, source)
);

CREATE INDEX IF NOT EXISTS idx_provider_cost_ledger_company ON provider_cost_ledger(company_id);
CREATE INDEX IF NOT EXISTS idx_provider_cost_ledger_provider ON provider_cost_ledger(provider);
CREATE INDEX IF NOT EXISTS idx_provider_cost_ledger_model ON provider_cost_ledger(model_id);
CREATE INDEX IF NOT EXISTS idx_provider_cost_ledger_period ON provider_cost_ledger(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_provider_cost_ledger_source ON provider_cost_ledger(source);
CREATE INDEX IF NOT EXISTS idx_provider_cost_ledger_provider_period ON provider_cost_ledger(provider, period_start DESC);
