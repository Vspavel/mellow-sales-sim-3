-- 009_agent_token_usage — per-run agent runtime token usage
-- Primary data source for Cost Ledger sync-scheduler.
-- Simpler, ingestion-oriented table focused on per-run token counts
-- from agent runtime (paperclip/pi agents), complementing model_token_ledger.

CREATE TABLE IF NOT EXISTS agent_token_usage (
  id TEXT PRIMARY KEY,

  -- Per-run linkage
  run_id TEXT NOT NULL,                     -- Paperclip run identifier
  agent_id TEXT,                            -- Agent that made the call
  issue_id TEXT,                            -- Related issue/task

  -- Provider/model
  provider TEXT NOT NULL,                   -- e.g. 'anthropic', 'openai'
  model_id TEXT NOT NULL,                   -- e.g. 'claude-sonnet-4-6', 'deepseek-chat'

  -- Token counts
  tokens_input BIGINT NOT NULL DEFAULT 0,
  tokens_output BIGINT NOT NULL DEFAULT 0,
  tokens_cache_read BIGINT DEFAULT 0,
  tokens_cache_write BIGINT DEFAULT 0,
  tokens_reasoning BIGINT DEFAULT 0,        -- reasoning/thinking tokens where applicable

  -- Provenance
  usage_source TEXT NOT NULL DEFAULT 'agent_report'
    CHECK (usage_source IN ('agent_report', 'estimated', 'provider_api')),

  -- Timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for sync-scheduler queries
CREATE INDEX IF NOT EXISTS idx_agent_token_usage_provider ON agent_token_usage(provider);
CREATE INDEX IF NOT EXISTS idx_agent_token_usage_model ON agent_token_usage(model_id);
CREATE INDEX IF NOT EXISTS idx_agent_token_usage_created_at ON agent_token_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_token_usage_run ON agent_token_usage(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_token_usage_provider_created ON agent_token_usage(provider, created_at DESC);

-- Aggregation helper: per-provider/model/monthly materialized view
-- Used by sync-scheduler to get real token counts per period.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_agent_token_monthly AS
SELECT
  provider,
  model_id,
  DATE_TRUNC('month', created_at) AS period_start,
  COUNT(*) AS call_count,
  SUM(tokens_input) AS tokens_input,
  SUM(tokens_output) AS tokens_output,
  SUM(tokens_cache_read) AS tokens_cache_read,
  SUM(tokens_cache_write) AS tokens_cache_write,
  SUM(tokens_reasoning) AS tokens_reasoning
FROM agent_token_usage
GROUP BY provider, model_id, DATE_TRUNC('month', created_at)
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_agent_token_monthly
  ON mv_agent_token_monthly(provider, model_id, period_start);
