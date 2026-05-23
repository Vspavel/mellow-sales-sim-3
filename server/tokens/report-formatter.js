// server/tokens/report-formatter.js
// Generates human-readable token usage reports from Token Ledger query data.
// Used by the /tokens/report endpoint and CLI scripts.
//
// Output format is designed to be parseable by qa/verify_consistency.py.
//
// Cost estimation: when pricingMap is provided, each model's token counts
// are multiplied by the per-1k-token prices from model_pricing_settings to
// produce an estimated USD cost. If no pricing exists for a model, cost shows
// as N/A. If pricing exists but all prices are zero, cost shows as $0.00
// with a "(default/zero)" note.

/**
 * Compute estimated cost for a single model from its token counts and pricing.
 *
 * @param {object} modelData - Token counts for a model (input_tokens, output_tokens, etc.)
 * @param {object|null} pricing - Pricing setting row or null
 * @returns {{ costUsd: number|null, hasExplicitPricing: boolean, detail: string }}
 */
export function computeModelCost(modelData, pricing) {
  if (!pricing) {
    return { costUsd: null, hasExplicitPricing: false, detail: 'N/A' };
  }

  let totalCost = 0;

  const priceFields = [
    { key: 'cost_per_input_token',       tokenSources: ['input_tokens', 'tokens_input', 'tokensInput', 'tokensinput'] },
    { key: 'cost_per_output_token',      tokenSources: ['output_tokens', 'tokens_output', 'tokensOutput', 'tokensoutput'] },
    { key: 'cost_per_cache_read_token',  tokenSources: ['cache_read_tokens', 'tokens_cache_read', 'tokensCacheRead', 'tokenscacheread'] },
    { key: 'cost_per_cache_write_token', tokenSources: ['cache_write_tokens', 'tokens_cache_write', 'tokensCacheWrite', 'tokenscachewrite'] },
  ];

  for (const pf of priceFields) {
    const pricePer1k = Number(pricing[pf.key] ?? 0);
    if (pricePer1k === 0) continue;

    let tokenVal = null;
    for (const src of pf.tokenSources) {
      if (modelData[src] !== undefined && modelData[src] !== null) {
        tokenVal = Number(modelData[src]);
        break;
      }
    }
    if (tokenVal === null || tokenVal === 0) continue;

    totalCost += (tokenVal / 1000) * pricePer1k;
  }

  const isDefaultZero = (
    Number(pricing.cost_per_input_token ?? 0) === 0 &&
    Number(pricing.cost_per_output_token ?? 0) === 0 &&
    Number(pricing.cost_per_cache_read_token ?? 0) === 0 &&
    Number(pricing.cost_per_cache_write_token ?? 0) === 0
  );

  const detail = isDefaultZero ? '$0.00 (default/zero)' : `$${totalCost.toFixed(6)}`;

  return { costUsd: totalCost, hasExplicitPricing: !isDefaultZero, detail };
}

/**
 * Build a pricing lookup map keyed by "{provider}::{modelId}" from an array of
 * model_pricing_settings rows.
 *
 * @param {object[]} pricingRows - Array of pricing setting rows from getPricingSettings()
 * @returns {object} Map keyed by "provider::modelId"
 */
export function buildPricingMap(pricingRows) {
  const map = {};
  for (const row of pricingRows) {
    const key = `${row.provider}::${row.model_id}`;
    map[key] = row;
  }
  return map;
}

/**
 * Enrich a model dictionary with computed cost estimates.
 * Mutates each model entry in-place, adding costEstimate object.
 *
 * @param {object} modelDict - { modelName: { provider, input_tokens, ... } }
 * @param {object} pricingMap - { "provider::modelId": pricingRow, ... }
 */
export function enrichModelDictWithCost(modelDict, pricingMap) {
  for (const [modelName, modelData] of Object.entries(modelDict)) {
    const provider = modelData.provider || 'unknown';
    const mapKey = `${provider}::${modelName}`;
    const pricing = pricingMap[mapKey] || null;
    modelData.costEstimate = computeModelCost(modelData, pricing);
  }
}

/**
 * Format a cost estimate line for the report.
 * @param {object} costEstimate - Result from computeModelCost
 * @returns {string}
 */
function formatCostLine(costEstimate) {
  if (!costEstimate) return '';
  const label = '  Estimated cost USD:';
  const padding = ' '.repeat(Math.max(1, 22 - 'Estimated cost USD'.length));
  return `${label}${padding}${costEstimate.detail}`;
}

/**
 * Generate a human-readable token usage report from token query data.
 *
 * Accepts:
 *   { models: { modelName: { provider, calls, input_tokens, ... } } }
 *   { models: [...] } (API by-model response — auto-converted)
 *   { records: [...] } (API by-run response — auto-aggregated)
 *
 * @param {object} data - Token usage data
 * @param {object} [options]
 * @param {object} [options.pricingMap] - Pricing lookup map from buildPricingMap()
 * @returns {string} Human-readable report
 */
export function formatRunReport(data, options = {}) {
  const modelDict = normalizeToModelDict(data);
  const lines = [];

  if (Object.keys(modelDict).length === 0) {
    return 'No token usage data available.\n';
  }

  // Enrich with cost estimates if pricing map provided
  if (options.pricingMap) {
    enrichModelDictWithCost(modelDict, options.pricingMap);
  }

  for (const [modelName, modelData] of Object.entries(modelDict)) {
    const provider = modelData.provider || modelData.Provider || 'unknown';
    const calls = modelData.calls ?? modelData.call_count ?? modelData.callCount ?? modelData.Calls ?? 0;

    lines.push(`Provider: ${provider}, Model: ${modelName}`);
    lines.push(`Calls: ${calls}`);

    const tokenFields = [
      { label: 'Input tokens',         keys: ['input_tokens', 'tokens_input', 'tokensInput', 'tokensinput'] },
      { label: 'Output tokens',        keys: ['output_tokens', 'tokens_output', 'tokensOutput', 'tokensoutput'] },
      { label: 'Cache read tokens',    keys: ['cache_read_tokens', 'tokens_cache_read', 'tokensCacheRead', 'tokenscacheread'] },
      { label: 'Cache write tokens',   keys: ['cache_write_tokens', 'tokens_cache_write', 'tokensCacheWrite', 'tokenscachewrite'] },
      { label: 'Reasoning tokens',     keys: ['reasoning_tokens', 'tokens_reasoning', 'tokensReasoning', 'tokensreasoning'] },
      { label: 'Prompt cache hit',     keys: ['prompt_cache_hit', 'tokens_prompt_cache_hit', 'tokensPromptCacheHit', 'tokenspromptcachehit'] },
      { label: 'Prompt cache miss',    keys: ['prompt_cache_miss', 'tokens_prompt_cache_miss', 'tokensPromptCacheMiss', 'tokenspromptcachemiss'] },
      { label: 'Total tokens',         keys: ['total_tokens', 'tokens_total', 'tokensTotal', 'tokenstotal'] },
    ];

    for (const tf of tokenFields) {
      let val = null;
      for (const k of tf.keys) {
        if (modelData[k] !== undefined && modelData[k] !== null) {
          val = modelData[k];
          break;
        }
      }
      if (val === null || val === undefined) continue;
      lines.push(`  ${tf.label}:${' '.repeat(Math.max(1, 22 - tf.label.length))}${val.toLocaleString('en-US')}`);
    }

    // Cost estimate line — shown after token counts, before accuracy
    if (modelData.costEstimate) {
      const costLine = formatCostLine(modelData.costEstimate);
      if (costLine) lines.push(costLine);
    }

    let accuracy = modelData.accuracy || modelData.Accuracy || modelData.source || modelData.Status || 'unknown';
    if (typeof accuracy === 'string') {
      lines.push(`  Accuracy: ${accuracy.toLowerCase()}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a model-summary report (includes grand totals).
 * @param {object} data - Response from /tokens/by-model or /tokens/summary
 * @param {object} [options] - Same options as formatRunReport
 * @returns {string}
 */
export function formatModelSummary(data, options = {}) {
  return formatRunReport(data, options);
}

/**
 * Generate a run report from a run ID and records.
 * @param {string} runId
 * @param {Array|object} data - records array or response object
 * @param {object} [options] - Same options as formatRunReport
 * @returns {string}
 */
export function generateRunReport(runId, data, options = {}) {
  const records = Array.isArray(data) ? data : (data.records || []);
  const aggregated = aggregateRecords(records);
  return formatRunReport({ models: aggregated }, options);
}

// ── Internal helpers ──

function normalizeToModelDict(data) {
  if (!data || typeof data !== 'object') return {};

  if (data.models && typeof data.models === 'object' && !Array.isArray(data.models)) {
    return data.models;
  }

  if (data.models && Array.isArray(data.models)) {
    const dict = {};
    for (const m of data.models) {
      const name = m.modelId || m.model_id || m.model || 'unknown';
      dict[name] = m;
    }
    return dict;
  }

  if (data.records && Array.isArray(data.records)) {
    return aggregateRecords(data.records);
  }

  return data;
}

function aggregateRecords(records) {
  const byKey = {};
  for (const rec of records) {
    const modelId = rec.modelId || rec.model_id || 'unknown';
    const provider = rec.provider || 'unknown';
    const key = `${provider}::${modelId}`;

    if (!byKey[key]) {
      byKey[key] = {
        provider,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 0,
        reasoning_tokens: null,
        prompt_cache_hit: null,
        prompt_cache_miss: null,
        accuracy: rec.accuracy || 'unknown',
      };
    }

    const agg = byKey[key];
    agg.calls++;

    const sumFields = [
      ['input_tokens', ['tokensInput', 'tokens_input']],
      ['output_tokens', ['tokensOutput', 'tokens_output']],
      ['cache_read_tokens', ['tokensCacheRead', 'tokens_cache_read']],
      ['cache_write_tokens', ['tokensCacheWrite', 'tokens_cache_write']],
      ['total_tokens', ['tokensTotal', 'tokens_total']],
    ];

    for (const [target, sources] of sumFields) {
      let val = null;
      for (const s of sources) {
        if (rec[s] !== undefined && rec[s] !== null) { val = Number(rec[s]); break; }
      }
      if (val !== null) agg[target] += val;
    }

    const nullableFields = [
      { target: 'reasoning_tokens', sources: ['reasoning_tokens', 'tokensReasoning', 'tokens_reasoning'] },
      { target: 'prompt_cache_hit', sources: ['prompt_cache_hit', 'tokensPromptCacheHit', 'tokens_prompt_cache_hit'] },
      { target: 'prompt_cache_miss', sources: ['prompt_cache_miss', 'tokensPromptCacheMiss', 'tokens_prompt_cache_miss'] },
    ];
    for (const nf of nullableFields) {
      let recVal = null;
      for (const s of nf.sources) {
        if (rec[s] !== undefined && rec[s] !== null) { recVal = Number(rec[s]); break; }
      }
      if (recVal !== null) {
        if (agg[nf.target] === null) agg[nf.target] = 0;
        agg[nf.target] += recVal;
      }
    }
  }

  const result = {};
  for (const [key, val] of Object.entries(byKey)) {
    result[key.split('::')[1]] = val;
  }
  return result;
}

/**
 * Register the human-readable report endpoint on the Express app.
 * GET /api/companies/:companyId/tokens/report?runId=xxx
 * Returns a plain text human-readable token report for the given run.
 * @param {import('express').Express} app
 */
export function registerReportEndpoint(app) {
  app.get('/api/companies/:companyId/tokens/report', async (req, res) => {
    try {
      const { runId } = req.query;
      const { companyId } = req.params;
      if (!runId) {
        return res.status(400).type('text/plain').send('runId query parameter is required\n');
      }
      // Import queryTokenRecords dynamically to avoid circular deps if any
      const { queryTokenRecords } = await import('./schema.js');
      const records = await queryTokenRecords({ runId });

      // Fetch pricing settings for cost estimation if companyId is available
      let pricingMap = null;
      if (companyId) {
        try {
          const { getPricingSettings } = await import('../pricing/schema.js');
          const pricingRows = await getPricingSettings({ companyId });
          pricingMap = buildPricingMap(pricingRows);
        } catch (pricingErr) {
          console.warn('[tokens:report] Pricing lookup unavailable, skipping cost estimation:', pricingErr.message);
        }
      }

      const report = generateRunReport(runId, records, { pricingMap });
      res.type('text/plain').send(report + '\n');
    } catch (err) {
      console.error('[tokens:report] Error:', err.message);
      res.status(500).type('text/plain').send('Failed to generate token report\n');
    }
  });

  // Also register under the /tokens namespace (non-auth'd internal route)
  app.get('/tokens/report', async (req, res) => {
    try {
      const { runId } = req.query;
      if (!runId) {
        return res.status(400).type('text/plain').send('runId query parameter is required\n');
      }
      const { queryTokenRecords } = await import('./schema.js');
      const records = await queryTokenRecords({ runId });
      // No companyId available on this route, so cost estimation is skipped
      const report = generateRunReport(runId, records);
      res.type('text/plain').send(report + '\n');
    } catch (err) {
      console.error('[tokens:report] Error:', err.message);
      res.status(500).type('text/plain').send('Failed to generate token report\n');
    }
  });

  console.log('[tokens] Report endpoint registered');
}
