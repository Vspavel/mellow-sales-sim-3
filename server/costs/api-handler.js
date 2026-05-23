// server/costs/api-handler.js — GET /api/companies/:companyId/costs/models
//
// Returns model-level cost data from the Cost Ledger (provider_cost_ledger table).
// The data includes token usage from both:
// - provider_billing_api: records fetched from provider billing APIs (requires credentials)
// - paperclip_estimated / paperclip_usage: records derived from runtime token usage
//   (no provider credentials required — this is the Cost Ledger token surface)
//
// The `source` field in each record distinguishes the provenance:
//   provider_billing_api  → from provider billing API (requires credentials)
//   paperclip_estimated   → from runtime token usage, aggregated monthly
//   paperclip_usage       → from agent_token_usage (real per-run token counts)

import { queryCostRecords, getCostSummary } from './schema.js';

/**
 * Register cost ledger API routes on the Express app.
 * @param {import('express').Express} app
 */
export function registerCostRoutes(app) {
  /**
   * GET /api/companies/:companyId/costs/models
   *
   * Returns model-level cost data with provenance.
   * Token usage is shown per record regardless of source.
   *
   * Query params:
   *   periodStart (string, ISO date) - Start of period (inclusive)
   *   periodEnd   (string, ISO date) - End of period (inclusive)
   *   provider    (string, comma-separated) - Provider filter
   *   modelId     (string) - Model ID filter
   *   source      (string) - Source filter ("provider_billing_api" | "paperclip_estimated" | "paperclip_usage")
   */
  app.get('/api/companies/:companyId/costs/models', async (req, res) => {
    try {
      const {
        periodStart,
        periodEnd,
        provider,
        modelId,
        source,
      } = req.query;

      // Default to last 30 days if no period specified
      const defaultEnd = new Date();
      const defaultStart = new Date();
      defaultStart.setDate(defaultStart.getDate() - 30);

      const start = periodStart || defaultStart.toISOString().slice(0, 10);
      const end = periodEnd || defaultEnd.toISOString().slice(0, 10);

      // Parse provider filter (comma-separated)
      let providers = null;
      if (provider) {
        providers = provider.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
      }

      const queryOpts = {
        periodStart: start,
        periodEnd: end,
        providers,
        modelId: modelId || undefined,
        source: source || undefined,
      };

      const [records, summary] = await Promise.all([
        queryCostRecords(queryOpts),
        getCostSummary(queryOpts),
      ]);

      res.json({
        period: { start, end },
        costs: records,
        summary,
      });
    } catch (err) {
      console.error('[costs] API error:', err.message);
      res.status(500).json({ error: 'Failed to query cost data' });
    }
  });
}
