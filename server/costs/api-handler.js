// server/costs/api-handler.js — Cost Ledger API routes
//
// Provides model-level cost data and summary from the Cost Ledger
// (provider_cost_ledger table), with optional proxy to the Paperclip API
// (pc.vspavel.com) for real production cost data.
//
// Proxy behaviour:
// - When PAPERCLIP_AUTH_SECRET env var is set, the handler first tries to
//   fetch cost data from the Paperclip API. On success, the response includes
//   _proxyMeta.provenance === "paperclip_api".
// - On network error or non-2xx from Paperclip, the handler logs the error and
//   falls back to the local database query.
// - When PAPERCLIP_AUTH_SECRET is NOT set, the handler uses only the local DB
//   with _proxyMeta.provenance === "local_db" and an explanatory _truthfulNote.
//
// All responses include:
//   _proxyMeta — provenance metadata describing how the data was sourced
//   _truthfulNote — human-readable note when data is clearly local-only/sample

import { queryCostRecords, getCostSummary } from './schema.js';

const PAPERCLIP_API_BASE = 'https://pc.vspavel.com';
const PROXY_TIMEOUT_MS = 5000;

/**
 * Build a _proxyMeta object for the response.
 * @param {'paperclip_api'|'local_db'} provenance
 * @param {boolean} paperclipApiReachable
 * @param {string|null} error
 */
function buildProxyMeta(provenance, paperclipApiReachable = false, error = null) {
  return {
    provenance,
    paperclipApiReachable,
    ...(error ? { error } : {}),
  };
}

/**
 * Build a _truthfulNote string based on total amount and proxy state.
 * @param {number} totalAmount
 * @param {'paperclip_api'|'local_db'} provenance
 */
function buildTruthfulNote(totalAmount, provenance) {
  if (provenance === 'paperclip_api') {
    return 'Cost data sourced from Paperclip API.';
  }
  if (!process.env.PAPERCLIP_AUTH_SECRET) {
    return 'Paperclip API proxy is not configured (PAPERCLIP_AUTH_SECRET env var not set). This dashboard shows cost data from the app\'s local database only.';
  }
  if (totalAmount < 1) {
    return 'This dashboard shows cost data from the app\'s local database. Production Paperclip cost data is not synced to this environment.';
  }
  return 'Cost data sourced from local database.';
}

/**
 * Fetch from the Paperclip API with a 5-second timeout.
 * Returns parsed JSON on success, or throws on network/non-2xx.
 * @param {string} url
 */
async function fetchPaperclipApi(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.PAPERCLIP_AUTH_SECRET}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Paperclip API returned ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attempt to fetch cost models from the Paperclip API proxy.
 * Returns null on failure (caller should fallback to local DB).
 * @param {string} companyId
 * @param {string} start
 * @param {string} end
 */
async function tryPaperclipModelsProxy(companyId, start, end) {
  const url = `${PAPERCLIP_API_BASE}/api/companies/${encodeURIComponent(companyId)}/costs/models?periodStart=${encodeURIComponent(start)}&periodEnd=${encodeURIComponent(end)}`;

  try {
    const data = await fetchPaperclipApi(url);
    return { costs: data.costs || [], period: data.period || { start, end } };
  } catch (err) {
    console.error('[costs] Paperclip API proxy error:', err.message);
    return null;
  }
}

/**
 * Attempt to fetch cost summary from the Paperclip API proxy.
 * Returns null on failure (caller should fallback to local DB).
 * @param {string} companyId
 * @param {string} start
 * @param {string} end
 * @param {Object} filters
 */
async function tryPaperclipSummaryProxy(companyId, start, end, filters = {}) {
  const params = new URLSearchParams({ periodStart: start, periodEnd: end });
  if (filters.provider) params.set('provider', filters.provider);
  if (filters.modelId) params.set('modelId', filters.modelId);
  if (filters.source) params.set('source', filters.source);

  const url = `${PAPERCLIP_API_BASE}/api/companies/${encodeURIComponent(companyId)}/costs/summary?${params.toString()}`;

  try {
    return await fetchPaperclipApi(url);
  } catch (err) {
    console.error('[costs] Paperclip API summary proxy error:', err.message);
    return null;
  }
}

/**
 * Build a models response with _proxyMeta and _truthfulNote.
 * @param {Array} records
 * @param {Object} summary
 * @param {Object} period
 * @param {Object} proxyMeta
 */
function buildModelsResponse(records, summary, period, proxyMeta) {
  const totalAmount = summary?.totalAmount ?? 0;
  return {
    period: { start: period.start, end: period.end },
    costs: records,
    summary,
    _proxyMeta: proxyMeta,
    _truthfulNote: buildTruthfulNote(totalAmount, proxyMeta.provenance),
  };
}

/**
 * Build a summary response with _proxyMeta and _truthfulNote.
 * @param {Object} data
 * @param {Object} proxyMeta
 */
function buildSummaryResponse(data, proxyMeta) {
  const totalAmount = data?.totalAmount ?? 0;
  return {
    ok: true,
    data,
    _proxyMeta: proxyMeta,
    _truthfulNote: buildTruthfulNote(totalAmount, proxyMeta.provenance),
  };
}

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

      // --- Try Paperclip API proxy first if configured ---
      if (process.env.PAPERCLIP_AUTH_SECRET) {
        const proxyResult = await tryPaperclipModelsProxy(req.params.companyId, start, end);
        if (proxyResult) {
          // Paperclip API may return a different summary shape; compute from costs
          const totalAmount = proxyResult.costs.reduce((sum, c) => sum + (c.amount || 0), 0);
          const proxySummary = {
            totalAmount: Math.round(totalAmount * 100) / 100,
            recordCount: proxyResult.costs.length,
          };
          const proxyMeta = buildProxyMeta('paperclip_api', true, null);
          return res.json(buildModelsResponse(proxyResult.costs, proxySummary, { start, end }, proxyMeta));
        }
        // Proxy failed — fall through to local DB below
      }

      // --- Local DB fallback ---
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

      const proxyApiConfigured = !!process.env.PAPERCLIP_AUTH_SECRET;
      const proxyMeta = buildProxyMeta(
        'local_db',
        proxyApiConfigured,
        proxyApiConfigured ? 'Paperclip API proxy failed, fell back to local database' : null
      );

      res.json(buildModelsResponse(records, summary, { start, end }, proxyMeta));
    } catch (err) {
      console.error('[costs] API error:', err.message);
      res.status(500).json({
        error: 'Failed to query cost data',
        _proxyMeta: buildProxyMeta('local_db', !!process.env.PAPERCLIP_AUTH_SECRET, err.message),
        _truthfulNote: 'An error occurred while fetching cost data.',
      });
    }
  });

  /**
   * GET /api/companies/:companyId/costs/summary
   *
   * Returns aggregated cost summary with provenance.
   *
   * Query params:
   *   periodStart (string, ISO date) - Start of period (inclusive)
   *   periodEnd   (string, ISO date) - End of period (inclusive)
   *   provider    (string) - Provider filter
   *   modelId     (string) - Model ID filter
   *   source      (string) - Source filter
   */
  app.get('/api/companies/:companyId/costs/summary', async (req, res) => {
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

      // --- Try Paperclip API proxy first if configured ---
      if (process.env.PAPERCLIP_AUTH_SECRET) {
        const proxyResult = await tryPaperclipSummaryProxy(
          req.params.companyId, start, end,
          { provider, modelId, source }
        );
        if (proxyResult && proxyResult.data) {
          const proxyMeta = buildProxyMeta('paperclip_api', true, null);
          return res.json(buildSummaryResponse(proxyResult.data, proxyMeta));
        }
        // Proxy failed — fall through to local DB below
      }

      // --- Local DB fallback ---
      // Parse provider filter (comma-separated) for local query
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

      const data = {
        totalAmount: summary.totalAmount,
        recordCount: records.length,
        byProvider: summary.byProvider,
        byModel: buildByModel(records),
        unavailableProviderCount: summary.unavailableProviderCount,
        estimatedOnlyAmount: summary.estimatedOnlyAmount,
      };

      const proxyApiConfigured = !!process.env.PAPERCLIP_AUTH_SECRET;
      const proxyMeta = buildProxyMeta(
        'local_db',
        proxyApiConfigured,
        proxyApiConfigured ? 'Paperclip API proxy failed, fell back to local database' : null
      );

      res.json(buildSummaryResponse(data, proxyMeta));
    } catch (err) {
      console.error('[costs] Summary API error:', err.message);
      res.status(500).json({
        ok: false,
        error: 'Failed to query cost summary',
        _proxyMeta: buildProxyMeta('local_db', !!process.env.PAPERCLIP_AUTH_SECRET, err.message),
        _truthfulNote: 'An error occurred while fetching cost summary.',
      });
    }
  });
}

/**
 * Build a byModel aggregation from cost records.
 * @param {Array} records
 */
function buildByModel(records) {
  const byModel = {};
  for (const r of records) {
    const key = r.modelId || 'unknown';
    if (!byModel[key]) {
      byModel[key] = { amount: 0, recordCount: 0 };
    }
    byModel[key].amount = Math.round((byModel[key].amount + r.amount) * 100) / 100;
    byModel[key].recordCount += 1;
  }
  return byModel;
}
