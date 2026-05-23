-- 011_model_token_ledger_company_id — Add company_id to model_token_ledger
--
-- The model_token_ledger table was created without a company_id column.
-- Pricing settings are scoped by company_id, so we need company_id on
-- the token ledger to backfill/find models that need pricing settings.
--
-- This migration:
--   1. Adds a nullable company_id column
--   2. Backfills existing records with 'company-default'
--   3. Sets company_id to NOT NULL
--   4. Creates indexes for efficient queries

ALTER TABLE model_token_ledger ADD COLUMN IF NOT EXISTS company_id TEXT;
UPDATE model_token_ledger SET company_id = 'company-default' WHERE company_id IS NULL;
ALTER TABLE model_token_ledger ALTER COLUMN company_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_token_ledger_company ON model_token_ledger (company_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_company_provider ON model_token_ledger (company_id, provider);
