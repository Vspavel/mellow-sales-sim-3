// server/tokens/queries.js — Token Ledger query endpoints
// GET /api/companies/:companyId/tokens/by-model
// GET /api/companies/:companyId/tokens/by-run
// GET /api/companies/:companyId/tokens/by-agent
// GET /api/companies/:companyId/tokens/by-issue
// GET /api/companies/:companyId/tokens/summary

import { queryTokenRecords, getTokenSummary } from './schema.js';

/**
 * Register all token query endpoints on the Express app.
 * @param {import('express').Express} app
 */
export function registerQueryEndpoints(app) {
  /**
   * GET /api/companies/:companyId/tokens/by-model
   * Query params: periodStart, periodEnd, provider, modelId
   */
  app.get('/api/companies/:companyId/tokens/by-model', async (req, res) => {
    try {
      const { periodStart, periodEnd, provider, modelId } = req.query;
      const summary = await getTokenSummary({
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
        provider: provider || undefined,
        modelId: modelId || undefined,
      });
      res.json({
        period: {
          start: periodStart || null,
          end: periodEnd || null,
        },
        models: summary.models,
        totals: {
          tokensInput: summary.tokensInput,
          tokensOutput: summary.tokensOutput,
          tokensCacheRead: summary.tokensCacheRead,
          tokensCacheWrite: summary.tokensCacheWrite,
          tokensTotal: summary.tokensTotal,
          tokensReasoning: summary.tokensReasoning,
          callCount: summary.totalCalls,
        },
      });
    } catch (err) {
      console.error('[tokens:by-model] Error:', err.message);
      res.status(500).json({ error: 'Failed to query token data by model' });
    }
  });

  /**
   * GET /api/companies/:companyId/tokens/by-run
   * Query params: runId (required)
   */
  app.get('/api/companies/:companyId/tokens/by-run', async (req, res) => {
    try {
      const { runId } = req.query;
      if (!runId) {
        return res.status(400).json({ error: 'runId query parameter is required' });
      }
      const records = await queryTokenRecords({ runId });
      res.json({ runId, records, count: records.length });
    } catch (err) {
      console.error('[tokens:by-run] Error:', err.message);
      res.status(500).json({ error: 'Failed to query token data by run' });
    }
  });

  /**
   * GET /api/companies/:companyId/tokens/by-agent
   * Query params: agentId (required), periodStart, periodEnd
   */
  app.get('/api/companies/:companyId/tokens/by-agent', async (req, res) => {
    try {
      const { agentId, periodStart, periodEnd } = req.query;
      if (!agentId) {
        return res.status(400).json({ error: 'agentId query parameter is required' });
      }
      const records = await queryTokenRecords({
        agentId,
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
      });
      res.json({ agentId, records, count: records.length });
    } catch (err) {
      console.error('[tokens:by-agent] Error:', err.message);
      res.status(500).json({ error: 'Failed to query token data by agent' });
    }
  });

  /**
   * GET /api/companies/:companyId/tokens/by-issue
   * Query params: issueId (required)
   */
  app.get('/api/companies/:companyId/tokens/by-issue', async (req, res) => {
    try {
      const { issueId } = req.query;
      if (!issueId) {
        return res.status(400).json({ error: 'issueId query parameter is required' });
      }
      const records = await queryTokenRecords({ issueId });
      res.json({ issueId, records, count: records.length });
    } catch (err) {
      console.error('[tokens:by-issue] Error:', err.message);
      res.status(500).json({ error: 'Failed to query token data by issue' });
    }
  });

  /**
   * GET /api/companies/:companyId/tokens/summary
   * Query params: periodStart, periodEnd, provider, modelId
   */
  app.get('/api/companies/:companyId/tokens/summary', async (req, res) => {
    try {
      const { periodStart, periodEnd, provider, modelId } = req.query;
      const summary = await getTokenSummary({
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
        provider: provider || undefined,
        modelId: modelId || undefined,
      });
      res.json({
        period: {
          start: periodStart || null,
          end: periodEnd || null,
        },
        totals: {
          totalCalls: summary.totalCalls,
          tokensInput: summary.tokensInput,
          tokensOutput: summary.tokensOutput,
          tokensCacheRead: summary.tokensCacheRead,
          tokensCacheWrite: summary.tokensCacheWrite,
          tokensTotal: summary.tokensTotal,
          tokensReasoning: summary.tokensReasoning,
        },
        models: summary.models,
        accuracyBreakdown: summary.accuracyBreakdown,
      });
    } catch (err) {
      console.error('[tokens:summary] Error:', err.message);
      res.status(500).json({ error: 'Failed to query token summary' });
    }
  });
}
