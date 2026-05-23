// server/tokens/ingest.js — POST /api/companies/:companyId/tokens/record
// Accepts raw provider usage data, normalizes via provider-mapping, and inserts into model_token_ledger.
// Also upserts aggregated token counts into the Cost Ledger (provider_cost_ledger) table.

import { insertTokenRecord } from './schema.js';
import { normalizeUsage } from './provider-mapping.js';
import { insertAgentTokenUsage } from './agent-token-service.js';
import { getPricingSettingByModel, upsertPricingSetting } from '../pricing/schema.js';

/**
 * Register the token ingest endpoint on the Express app.
 * @param {import('express').Express} app
 */
export function registerIngestEndpoint(app) {
  /**
   * POST /api/companies/:companyId/tokens/record
   *
   * Accepts a per-call token usage record from the runtime.
   * The `raw_usage` object is provider-specific and gets normalized
   * via provider-mapping into the common Token Ledger schema.
   *
   * The token data is also bridged to the Cost Ledger (provider_cost_ledger)
   * via upsertCostLedgerTokens(), so Cost Ledger API endpoints like
   * GET /api/companies/:companyId/costs/models show token usage without
   * requiring provider billing API credentials.
   *
   * Request body:
   * {
   *   provider: string (required) — e.g., 'anthropic', 'openai', 'deepseek'
   *   model_id: string (required) — e.g., 'claude-sonnet-4-6'
   *   raw_usage: object|null — provider-specific usage response (stored as JSONB)
   *   accuracy: string — 'provider_reported' | 'runtime_estimated' | 'missing_usage'
   *   run_id: string|null
   *   agent_id: string|null
   *   issue_id: string|null
   *   session_id: string|null
   *   api: string — provider API name (default: 'unknown')
   *   call_type: string — 'llm' (default) | 'embedding' | 'image' | 'audio'
   *   called_at: string (ISO timestamp) — when the model call was made
   *   tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
   *   tokens_total, tokens_reasoning, tokens_prompt_cache_hit,
   *   tokens_prompt_cache_miss: number|null — explicit override (bypasses normalization)
   * }
   */
  app.post('/api/companies/:companyId/tokens/record', async (req, res) => {
    try {
      const body = req.body || {};
      const companyIdFromUrl = req.params.companyId;

      // --- Validation ---
      const provider = (body.provider || '').trim().toLowerCase();
      if (!provider) {
        return res.status(400).json({ error: 'provider is required' });
      }

      const modelId = (body.model_id || '').trim();
      if (!modelId) {
        return res.status(400).json({ error: 'model_id is required' });
      }

      const accuracy = body.accuracy || 'provider_reported';
      if (!['provider_reported', 'runtime_estimated', 'missing_usage'].includes(accuracy)) {
        return res.status(400).json({
          error: `invalid accuracy value "${accuracy}". Must be one of: provider_reported, runtime_estimated, missing_usage`,
        });
      }

      // --- Normalize provider-specific usage ---
      const rawUsage = body.raw_usage || null;
      const normalized = normalizeUsage(provider, rawUsage);

      // Build the record for insertion
      const record = {
        companyId: companyIdFromUrl,
        provider,
        modelId,
        api: body.api || 'unknown',
        callType: body.call_type || 'llm',
        runId: body.run_id || null,
        agentId: body.agent_id || null,
        issueId: body.issue_id || null,
        sessionId: body.session_id || null,
        accuracy,
        calledAt: body.called_at || new Date().toISOString(),
        rawProviderUsage: rawUsage,
        // Use normalized values (from provider-mapping) if caller didn't override
        tokensInput: body.tokens_input ?? normalized.tokens_input,
        tokensOutput: body.tokens_output ?? normalized.tokens_output,
        tokensCacheRead: body.tokens_cache_read ?? normalized.tokens_cache_read,
        tokensCacheWrite: body.tokens_cache_write ?? normalized.tokens_cache_write,
        tokensTotal: body.tokens_total ?? normalized.tokens_total,
        tokensReasoning: body.tokens_reasoning ?? normalized.tokens_reasoning,
        tokensPromptCacheHit: body.tokens_prompt_cache_hit ?? normalized.tokens_prompt_cache_hit,
        tokensPromptCacheMiss: body.tokens_prompt_cache_miss ?? normalized.tokens_prompt_cache_miss,
        costUsdCents: body.cost_usd_cents ?? null,
      };

      // Auto-calculate total from components if not explicitly provided
      if (!record.tokensTotal && (record.tokensInput || record.tokensOutput || record.tokensCacheRead || record.tokensCacheWrite)) {
        record.tokensTotal = record.tokensInput + record.tokensOutput + record.tokensCacheRead + record.tokensCacheWrite;
      }

      const inserted = await insertTokenRecord(record);

      // Also write to agent_token_usage (primary source for sync-scheduler)
      await insertAgentTokenUsage({
        runId: record.runId,
        agentId: record.agentId,
        issueId: record.issueId,
        provider: record.provider,
        modelId: record.modelId,
        tokensInput: record.tokensInput,
        tokensOutput: record.tokensOutput,
        tokensCacheRead: record.tokensCacheRead,
        tokensCacheWrite: record.tokensCacheWrite,
        tokensReasoning: record.tokensReasoning,
        usageSource: record.accuracy === 'provider_reported' ? 'agent_report' : 'estimated',
      }).catch((err) => {
        console.warn('[tokens:ingest] agent_token_usage insert skipped:', err.message);
      });

      // Also upsert aggregated token counts into Cost Ledger (best-effort, non-blocking)
      await upsertCostLedgerTokens(record, companyIdFromUrl).catch((err) => {
        console.warn('[tokens:ingest] Cost Ledger upsert skipped:', err.message);
      });

      // Auto-create pricing setting for this model if none exists (fire-and-forget)
      ensurePricingSetting(companyIdFromUrl, provider, modelId).catch((err) => {
        console.warn('[tokens:ingest] Pricing setting auto-create skipped:', err.message);
      });

      res.status(201).json({
        ok: true,
        record: inserted,
      });
    } catch (err) {
      console.error('[tokens:ingest] Error:', err.message);
      res.status(500).json({ error: 'Failed to record token usage', detail: err.message });
    }
  });
}

/**
 * Upsert aggregated token counts into Cost Ledger's provider_cost_ledger table.
 * Uses the month of called_at as the period. Source is 'paperclip_estimated'.
 * Amount is 0 (no USD billing in scope). This is best-effort: fails silently
 * when PostgreSQL is unavailable (e.g., STORAGE_DRIVER=file).
 *
 * This is the primary bridge from runtime token usage to the Cost Ledger token surface.
 * The Cost Ledger API (GET /api/companies/:companyId/costs/models) returns these records
 * alongside billing API records, with the source field distinguishing them.
 */
/**
 * ensurePricingSetting — Auto-create a default pricing setting for a model if none exists.
 * Fire-and-forget: never throws. Errors are logged and swallowed.
 */
async function ensurePricingSetting(companyId, provider, modelId) {
  if (!process.env.DATABASE_URL) return;
  try {
    const existing = await getPricingSettingByModel(companyId, provider, modelId);
    if (!existing) {
      await upsertPricingSetting({
        companyId,
        provider,
        modelId,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        costPerCacheReadToken: 0,
        costPerCacheWriteToken: 0,
        isDefault: true,
        label: `Auto-created from token ingest`,
      });
    }
  } catch (err) {
    // Log but never throw — this is best-effort
    console.warn('[tokens:ingest] ensurePricingSetting error:', err.message);
  }
}

async function upsertCostLedgerTokens(record, companyId) {
  if (!process.env.DATABASE_URL) return; // Skip if no Postgres

  const calledDate = new Date(record.calledAt || Date.now());
  const periodStart = new Date(Date.UTC(calledDate.getUTCFullYear(), calledDate.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const periodEnd = new Date(Date.UTC(calledDate.getUTCFullYear(), calledDate.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const { upsertCostRecord } = await import('../costs/schema.js');
  await upsertCostRecord({
    provider: record.provider,
    modelId: record.modelId,
    periodStart,
    periodEnd,
    amount: 0, // No USD billing in scope
    currency: 'USD',
    tokensInput: record.tokensInput,
    tokensOutput: record.tokensOutput,
    tokensCacheRead: record.tokensCacheRead,
    tokensCacheWrite: record.tokensCacheWrite,
    runCount: 1,
    source: 'paperclip_estimated',
    syncStatus: 'fresh',
    isVerified: true,
    companyId,
  });
}
