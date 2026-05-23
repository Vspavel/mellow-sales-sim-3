// server/tokens/schema.js — model_token_ledger DB CRUD operations
//
// Auto-detects available storage backend:
// - PostgreSQL via db/client.js when DATABASE_URL is set
// - JSON file-based local-store when DATABASE_URL is not set (dev/testing)

import crypto from 'crypto';

const TABLE = 'model_token_ledger';

// Lazy storage backend detection: try Postgres first, fall back to file store
let store = null;

async function getStore() {
  if (store) return store;

  // Try Postgres if DATABASE_URL is set
  if (process.env.DATABASE_URL) {
    try {
      const { query } = await import('../../db/client.js');
      store = { driver: 'postgres', query };
      console.log('[tokens:schema] Using PostgreSQL storage');
      return store;
    } catch (err) {
      console.warn('[tokens:schema] Postgres unavailable, falling back to file store:', err.message);
    }
  }

  // Fall back to JSON file store
  const { insertTokenRecordLocal, queryTokenRecordsLocal, getTokenSummaryLocal } = await import('./local-store.js');
  store = {
    driver: 'file',
    query: null,
    insertTokenRecordLocal,
    queryTokenRecordsLocal,
    getTokenSummaryLocal,
  };
  console.log('[tokens:schema] Using file-local token store (data/token-ledger.json)');
  return store;
}

/**
 * @typedef {Object} TokenRecord
 * @property {string} id
 * @property {string|null} runId
 * @property {string|null} agentId
 * @property {string|null} issueId
 * @property {string|null} sessionId
 * @property {string} provider
 * @property {string} modelId
 * @property {string} api
 * @property {string} callType
 * @property {number} tokensInput
 * @property {number} tokensOutput
 * @property {number} tokensCacheRead
 * @property {number} tokensCacheWrite
 * @property {number} tokensTotal
 * @property {number|null} tokensReasoning
 * @property {number|null} tokensPromptCacheHit
 * @property {number|null} tokensPromptCacheMiss
 * @property {number|null} tokensAudioInput
 * @property {number|null} tokensAudioOutput
 * @property {object|null} rawProviderUsage
 * @property {string} accuracy
 * @property {number|null} costUsdCents
 * @property {string} calledAt
 * @property {string} recordedAt
 * @property {string} updatedAt
 */

function rowToRecord(row) {
  return {
    id: row.id,
    companyId: row.company_id ?? null,
    runId: row.run_id,
    agentId: row.agent_id,
    issueId: row.issue_id,
    sessionId: row.session_id,
    provider: row.provider,
    modelId: row.model_id,
    api: row.api,
    callType: row.call_type,
    tokensInput: Number(row.tokens_input),
    tokensOutput: Number(row.tokens_output),
    tokensCacheRead: Number(row.tokens_cache_read),
    tokensCacheWrite: Number(row.tokens_cache_write),
    tokensTotal: Number(row.tokens_total),
    tokensReasoning: row.tokens_reasoning != null ? Number(row.tokens_reasoning) : null,
    tokensPromptCacheHit: row.tokens_prompt_cache_hit != null ? Number(row.tokens_prompt_cache_hit) : null,
    tokensPromptCacheMiss: row.tokens_prompt_cache_miss != null ? Number(row.tokens_prompt_cache_miss) : null,
    tokensAudioInput: row.tokens_audio_input != null ? Number(row.tokens_audio_input) : null,
    tokensAudioOutput: row.tokens_audio_output != null ? Number(row.tokens_audio_output) : null,
    rawProviderUsage: row.raw_provider_usage,
    accuracy: row.accuracy,
    costUsdCents: row.cost_usd_cents != null ? Number(row.cost_usd_cents) : null,
    calledAt: row.called_at instanceof Date ? row.called_at.toISOString() : String(row.called_at),
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function generateId() {
  return crypto.randomUUID();
}

/**
 * Insert a single token usage record.
 * Uses PostgreSQL when DATABASE_URL is set, otherwise JSON file store.
 * @param {object} record — fields matching the model_token_ledger columns (camelCase or snake_case)
 * @returns {Promise<TokenRecord>}
 */
export async function insertTokenRecord(record) {
  const s = await getStore();

  // File store path
  if (s.driver === 'file') {
    const result = await s.insertTokenRecordLocal(record);
    return result;
  }

  // PostgreSQL path
  const id = record.id || generateId();
  const sql = `
    INSERT INTO ${TABLE} (
      id, company_id, run_id, agent_id, issue_id, session_id,
      provider, model_id, api, call_type,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_total,
      tokens_reasoning, tokens_prompt_cache_hit, tokens_prompt_cache_miss,
      tokens_audio_input, tokens_audio_output,
      raw_provider_usage, accuracy, cost_usd_cents,
      called_at, recorded_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18,
      $19, $20,
      $21, $22, $23,
      $24, NOW(), NOW()
    )
    RETURNING *
  `;
  const params = [
    id,
    record.companyId || record.company_id || null,
    record.runId || record.run_id || null,
    record.agentId || record.agent_id || null,
    record.issueId || record.issue_id || null,
    record.sessionId || record.session_id || null,
    record.provider,
    record.modelId || record.model_id,
    record.api || 'unknown',
    record.callType || record.call_type || 'llm',
    record.tokensInput ?? record.tokens_input ?? 0,
    record.tokensOutput ?? record.tokens_output ?? 0,
    record.tokensCacheRead ?? record.tokens_cache_read ?? 0,
    record.tokensCacheWrite ?? record.tokens_cache_write ?? 0,
    record.tokensTotal ?? record.tokens_total ?? 0,
    record.tokensReasoning ?? record.tokens_reasoning ?? null,
    record.tokensPromptCacheHit ?? record.tokens_prompt_cache_hit ?? null,
    record.tokensPromptCacheMiss ?? record.tokens_prompt_cache_miss ?? null,
    record.tokensAudioInput ?? record.tokens_audio_input ?? null,
    record.tokensAudioOutput ?? record.tokens_audio_output ?? null,
    record.rawProviderUsage != null
      ? (typeof record.rawProviderUsage === 'string' ? record.rawProviderUsage : JSON.stringify(record.rawProviderUsage))
      : record.raw_provider_usage != null
        ? (typeof record.raw_provider_usage === 'string' ? record.raw_provider_usage : JSON.stringify(record.raw_provider_usage))
        : null,
    record.accuracy || 'provider_reported',
    record.costUsdCents ?? record.cost_usd_cents ?? null,
    record.calledAt || record.called_at || new Date().toISOString(),
  ];
  const result = await s.query(sql, params);
  return rowToRecord(result.rows[0]);
}

/**
 * Query token records with optional filters.
 * Uses PostgreSQL when DATABASE_URL is set, otherwise JSON file store.
 * @param {object} opts
 * @param {string} [opts.periodStart] - ISO date string (inclusive)
 * @param {string} [opts.periodEnd] - ISO date string (inclusive)
 * @param {string} [opts.provider]
 * @param {string} [opts.modelId]
 * @param {string} [opts.runId]
 * @param {string} [opts.agentId]
 * @param {string} [opts.issueId]
 * @param {string} [opts.accuracy]
 * @param {number} [opts.limit] - max rows to return
 * @param {number} [opts.offset] - pagination offset
 * @returns {Promise<TokenRecord[]>}
 */
export async function queryTokenRecords(opts = {}) {
  const s = await getStore();

  // File store path
  if (s.driver === 'file') {
    return s.queryTokenRecordsLocal(opts);
  }

  // PostgreSQL path
  const conditions = [];
  const params = [];
  let idx = 1;

  if (opts.periodStart) {
    conditions.push(`called_at >= $${idx++}::timestamptz`);
    params.push(opts.periodStart);
  }
  if (opts.periodEnd) {
    conditions.push(`called_at <= $${idx++}::timestamptz`);
    params.push(opts.periodEnd);
  }
  if (opts.companyId) {
    conditions.push(`company_id = $${idx++}`);
    params.push(opts.companyId);
  }
  if (opts.provider) {
    conditions.push(`provider = $${idx++}`);
    params.push(opts.provider);
  }
  if (opts.modelId) {
    conditions.push(`model_id = $${idx++}`);
    params.push(opts.modelId);
  }
  if (opts.runId) {
    conditions.push(`run_id = $${idx++}`);
    params.push(opts.runId);
  }
  if (opts.agentId) {
    conditions.push(`agent_id = $${idx++}`);
    params.push(opts.agentId);
  }
  if (opts.issueId) {
    conditions.push(`issue_id = $${idx++}`);
    params.push(opts.issueId);
  }
  if (opts.accuracy) {
    conditions.push(`accuracy = $${idx++}`);
    params.push(opts.accuracy);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = opts.limit ? `LIMIT ${parseInt(opts.limit, 10)}` : '';
  const offsetClause = opts.offset ? `OFFSET ${parseInt(opts.offset, 10)}` : '';
  const sql = `SELECT * FROM ${TABLE} ${where} ORDER BY called_at DESC ${limitClause} ${offsetClause}`.trim();
  const result = await s.query(sql, params);
  return result.rows.map(rowToRecord);
}

/**
 * Get token summary: per-model/provider aggregation with accuracy breakdown.
 * Uses PostgreSQL when DATABASE_URL is set, otherwise JSON file store.
 * @param {object} opts
 * @param {string} [opts.periodStart]
 * @param {string} [opts.periodEnd]
 * @param {string} [opts.provider]
 * @param {string} [opts.modelId]
 * @returns {Promise<object>}
 */
export async function getTokenSummary(opts = {}) {
  const s = await getStore();

  // File store path
  if (s.driver === 'file') {
    return s.getTokenSummaryLocal(opts);
  }

  // PostgreSQL path
  const conditions = [];
  const params = [];
  let idx = 1;

  if (opts.periodStart) {
    conditions.push(`called_at >= $${idx++}::timestamptz`);
    params.push(opts.periodStart);
  }
  if (opts.periodEnd) {
    conditions.push(`called_at <= $${idx++}::timestamptz`);
    params.push(opts.periodEnd);
  }
  if (opts.companyId) {
    conditions.push(`company_id = $${idx++}`);
    params.push(opts.companyId);
  }
  if (opts.provider) {
    conditions.push(`provider = $${idx++}`);
    params.push(opts.provider);
  }
  if (opts.modelId) {
    conditions.push(`model_id = $${idx++}`);
    params.push(opts.modelId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Per-model aggregation
  const modelSql = `
    SELECT
      provider, model_id,
      SUM(tokens_input) AS tokens_input,
      SUM(tokens_output) AS tokens_output,
      SUM(tokens_cache_read) AS tokens_cache_read,
      SUM(tokens_cache_write) AS tokens_cache_write,
      SUM(tokens_total) AS tokens_total,
      SUM(tokens_reasoning) AS tokens_reasoning,
      SUM(tokens_prompt_cache_hit) AS tokens_prompt_cache_hit,
      SUM(tokens_prompt_cache_miss) AS tokens_prompt_cache_miss,
      COUNT(*) AS call_count
    FROM ${TABLE}
    ${where}
    GROUP BY provider, model_id
    ORDER BY provider, model_id
  `;
  const modelResult = await s.query(modelSql, params);

  // Accuracy breakdown
  const accuracySql = `
    SELECT
      accuracy,
      COUNT(*) AS count,
      SUM(tokens_total) AS tokens_total
    FROM ${TABLE}
    ${where}
    GROUP BY accuracy
    ORDER BY accuracy
  `;
  const accuracyResult = await s.query(accuracySql, params);

  // Grand totals
  const totalSql = `
    SELECT
      COUNT(*) AS total_calls,
      SUM(tokens_input) AS tokens_input,
      SUM(tokens_output) AS tokens_output,
      SUM(tokens_cache_read) AS tokens_cache_read,
      SUM(tokens_cache_write) AS tokens_cache_write,
      SUM(tokens_total) AS tokens_total,
      SUM(tokens_reasoning) AS tokens_reasoning
    FROM ${TABLE}
    ${where}
  `;
  const totalResult = await s.query(totalSql, params);

  const models = modelResult.rows.map((r) => ({
    provider: r.provider,
    modelId: r.model_id,
    tokensInput: Number(r.tokens_input),
    tokensOutput: Number(r.tokens_output),
    tokensCacheRead: Number(r.tokens_cache_read),
    tokensCacheWrite: Number(r.tokens_cache_write),
    tokensTotal: Number(r.tokens_total),
    tokensReasoning: r.tokens_reasoning != null ? Number(r.tokens_reasoning) : null,
    tokensPromptCacheHit: r.tokens_prompt_cache_hit != null ? Number(r.tokens_prompt_cache_hit) : null,
    tokensPromptCacheMiss: r.tokens_prompt_cache_miss != null ? Number(r.tokens_prompt_cache_miss) : null,
    callCount: Number(r.call_count),
  }));

  const accuracyBreakdown = accuracyResult.rows.map((r) => ({
    accuracy: r.accuracy,
    count: Number(r.count),
    tokensTotal: Number(r.tokens_total),
  }));

  const totals = totalResult.rows[0] || {};
  return {
    totalCalls: Number(totals.total_calls || 0),
    tokensInput: Number(totals.tokens_input || 0),
    tokensOutput: Number(totals.tokens_output || 0),
    tokensCacheRead: Number(totals.tokens_cache_read || 0),
    tokensCacheWrite: Number(totals.tokens_cache_write || 0),
    tokensTotal: Number(totals.tokens_total || 0),
    tokensReasoning: totals.tokens_reasoning != null ? Number(totals.tokens_reasoning) : null,
    models,
    accuracyBreakdown,
  };
}
