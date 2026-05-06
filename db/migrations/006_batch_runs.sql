-- 006_batch_runs — batch simulation run tracking

CREATE TABLE IF NOT EXISTS batch_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  config JSONB NOT NULL DEFAULT '{}',
  progress JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS batch_sessions (
  id TEXT PRIMARY KEY,
  batch_run_id TEXT NOT NULL REFERENCES batch_runs(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  messages JSONB NOT NULL DEFAULT '[]',
  assessment JSONB,
  human_likeness_scores JSONB NOT NULL DEFAULT '[]',
  human_likeness_avg REAL,
  meeting_booked BOOLEAN NOT NULL DEFAULT FALSE,
  turns INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS analysis_reports (
  id TEXT PRIMARY KEY,
  batch_run_id TEXT NOT NULL REFERENCES batch_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  actions JSONB,
  patterns JSONB,
  raw JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_batch_sessions_run ON batch_sessions(batch_run_id);
CREATE INDEX IF NOT EXISTS idx_analysis_reports_run ON analysis_reports(batch_run_id);
CREATE INDEX IF NOT EXISTS idx_batch_runs_status ON batch_runs(status);
CREATE INDEX IF NOT EXISTS idx_batch_runs_created ON batch_runs(created_at DESC);
