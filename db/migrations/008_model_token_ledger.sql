-- 008_model_token_ledger — per-call token usage by model/provider
-- Token-first reporting system (not monetary).
-- Companion table to provider_cost_ledger (separate concerns).

CREATE TABLE IF NOT EXISTS model_token_ledger (
  id TEXT PRIMARY KEY,

  -- Linkage
  run_id TEXT,                              -- Paperclip agent run ID
  agent_id TEXT,                            -- Agent that made the call
  issue_id TEXT,                            -- Task/issue ID being worked on
  session_id TEXT,                          -- Provider session ID (cache affinity)

  -- Call metadata
  provider TEXT NOT NULL,                   -- e.g., 'anthropic', 'openai', 'deepseek'
  model_id TEXT NOT NULL,                   -- e.g., 'claude-sonnet-4-6', 'deepseek-chat'
  api TEXT NOT NULL,                        -- e.g., 'anthropic-messages', 'openai-completions'
  call_type TEXT NOT NULL DEFAULT 'llm',    -- 'llm' | 'embedding' | 'image' | 'audio' (future)

  -- Normalized token counts (pi-ai Usage shape)
  tokens_input BIGINT NOT NULL DEFAULT 0,
  tokens_output BIGINT NOT NULL DEFAULT 0,
  tokens_cache_read BIGINT NOT NULL DEFAULT 0,
  tokens_cache_write BIGINT NOT NULL DEFAULT 0,
  tokens_total BIGINT NOT NULL DEFAULT 0,

  -- Provider-specific extended fields (when available)
  tokens_reasoning BIGINT,                  -- DeepSeek reasoning_tokens, Claude thinking tokens
  tokens_prompt_cache_hit BIGINT,           -- DeepSeek prompt_cache_hit_tokens
  tokens_prompt_cache_miss BIGINT,          -- DeepSeek prompt_cache_miss_tokens
  tokens_audio_input BIGINT,                -- Future: audio input tokens
  tokens_audio_output BIGINT,               -- Future: audio output tokens

  -- Raw provider response (JSONB for audit/debug)
  raw_provider_usage JSONB,

  -- Accuracy label
  accuracy TEXT NOT NULL DEFAULT 'provider_reported'
    CHECK (accuracy IN ('provider_reported', 'runtime_estimated', 'missing_usage')),

  -- Cost (USD, nullable — derived from model pricing, not source of truth)
  cost_usd_cents INTEGER,

  -- Timestamp
  called_at TIMESTAMPTZ NOT NULL,           -- When the model call was made
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_token_ledger_provider ON model_token_ledger(provider);
CREATE INDEX IF NOT EXISTS idx_token_ledger_model ON model_token_ledger(model_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_called_at ON model_token_ledger(called_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_ledger_provider_model ON model_token_ledger(provider, model_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_run ON model_token_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_agent ON model_token_ledger(agent_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_issue ON model_token_ledger(issue_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_accuracy ON model_token_ledger(accuracy);
