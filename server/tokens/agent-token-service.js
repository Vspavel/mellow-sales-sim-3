// server/tokens/agent-token-service.js — agent_token_usage CRUD and aggregation
//
// This module provides the data-access layer for the agent_token_usage table,
// which serves as the primary source of truth for per-run token usage from
// agent runtime. The sync-scheduler queries this table to populate the Cost
// Ledger with real token counts instead of placeholder zeros.
//
// Storage backend auto-detection:
// - PostgreSQL via db/client.js when DATABASE_URL is set
// - JSON file-based local store fallback (dev/testing)

import crypto from 'crypto';

const TABLE = 'agent_token_usage';

// Lazy storage backend
let store = null;

async function getStore() {
  if (store) return store;

  // Try Postgres if DATABASE_URL is set
  if (process.env.DATABASE_URL) {
    try {
      const { query } = await import('../../db/client.js');
      store = { driver: 'postgres', query };
      console.log('[agent-token] Using PostgreSQL storage');
      return store;
    } catch (err) {
      console.warn('[agent-token] Postgres unavailable, falling back to file store:', err.message);
    }
  }

  // Fall back to JSON file store
  const { LocalAgentTokenStore } = await import('./local-agent-token-store.js');
  const localStore = new LocalAgentTokenStore();
  store = {
    driver: 'file',
    query: null,
    localStore,
  };
  console.log('[agent-token] Using file-local store');
  return store;
}

function generateId() {
  return crypto.randomUUID();
}

/**
 * @typedef {Object} AgentTokenUsage
 * @property {string} id
 * @property {string} runId
 * @property {string|null} agentId
 * @property {string|null} issueId
 * @property {string} provider
 * @property {string} modelId
 * @property {number} tokensInput
 * @property {number} tokensOutput
 * @property {number} tokensCacheRead
 * @property {number} tokensCacheWrite
 * @property {number} tokensReasoning
 * @property {string} usageSource
 * @property {string} createdAt
 */

function rowToRecord(row) {
  return {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    issueId: row.issue_id,
    provider: row.provider,
    modelId: row.model_id,
    tokensInput: Number(row.tokens_input),
    tokensOutput: Number(row.tokens_output),
    tokensCacheRead: Number(row.tokens_cache_read || 0),
    tokensCacheWrite: Number(row.tokens_cache_write || 0),
    tokensReasoning: Number(row.tokens_reasoning || 0),
    usageSource: row.usage_source,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * Insert a single agent_token_usage record.
 * @param {object} record
 * @returns {Promise<AgentTokenUsage>}
 */
export async function insertAgentTokenUsage(record) {
  const s = await getStore();

  if (s.driver === 'file') {
    return s.localStore.insertRecord(record);
  }

  // PostgreSQL
  const id = record.id || generateId();
  const sql = `
    INSERT INTO ${TABLE} (
      id, run_id, agent_id, issue_id,
      provider, model_id,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_reasoning,
      usage_source, created_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6,
      $7, $8, $9, $10, $11,
      $12, NOW()
    )
    RETURNING *
  `;
  const params = [
    id,
    record.runId || record.run_id,
    record.agentId || record.agent_id || null,
    record.issueId || record.issue_id || null,
    record.provider,
    record.modelId || record.model_id,
    record.tokensInput ?? record.tokens_input ?? 0,
    record.tokensOutput ?? record.tokens_output ?? 0,
    record.tokensCacheRead ?? record.tokens_cache_read ?? 0,
    record.tokensCacheWrite ?? record.tokens_cache_write ?? 0,
    record.tokensReasoning ?? record.tokens_reasoning ?? 0,
    record.usageSource || record.usage_source || 'agent_report',
  ];
  const result = await s.query(sql, params);
  return rowToRecord(result.rows[0]);
}

/**
 * Query agent_token_usage records with optional filters.
 * @param {object} opts
 * @param {string} [opts.periodStart] - ISO date string (inclusive)
 * @param {string} [opts.periodEnd] - ISO date string (inclusive)
 * @param {string} [opts.provider]
 * @param {string} [opts.modelId]
 * @param {string} [opts.runId]
 * @param {string} [opts.agentId]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @returns {Promise<AgentTokenUsage[]>}
 */
export async function queryAgentTokenUsage(opts = {}) {
  const s = await getStore();

  if (s.driver === 'file') {
    return s.localStore.queryRecords(opts);
  }

  // PostgreSQL
  const conditions = [];
  const params = [];
  let idx = 1;

  if (opts.periodStart) {
    conditions.push(`created_at >= $${idx++}::timestamptz`);
    params.push(opts.periodStart);
  }
  if (opts.periodEnd) {
    conditions.push(`created_at <= $${idx++}::timestamptz`);
    params.push(opts.periodEnd);
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

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = opts.limit ? `LIMIT ${parseInt(opts.limit, 10)}` : '';
  const offsetClause = opts.offset ? `OFFSET ${parseInt(opts.offset, 10)}` : '';
  const sql = `SELECT * FROM ${TABLE} ${where} ORDER BY created_at DESC ${limitClause} ${offsetClause}`.trim();
  const result = await s.query(sql, params);
  return result.rows.map(rowToRecord);
}

/**
 * Get aggregated token usage by provider and model for a given period.
 * This is the primary query used by the Cost Ledger sync-scheduler.
 *
 * @param {object} opts
 * @param {string} opts.periodStart - ISO date string (inclusive)
 * @param {string} opts.periodEnd - ISO date string (inclusive)
 * @param {string} [opts.provider] - Optionally filter by provider
 * @param {string} [opts.modelId] - Optionally filter by model
 * @returns {Promise<Array<{provider: string, modelId: string, monthStart: string, callCount: number, tokensInput: number, tokensOutput: number, tokensCacheRead: number, tokensCacheWrite: number, tokensReasoning: number}>>}
 */
export async function getAggregatedTokenUsage(opts = {}) {
  const s = await getStore();

  if (s.driver === 'file') {
    return s.localStore.getAggregatedUsage(opts);
  }

  const conditions = [];
  const params = [];
  let idx = 1;

  if (opts.periodStart) {
    conditions.push(`created_at >= $${idx++}::timestamptz`);
    params.push(opts.periodStart);
  }
  if (opts.periodEnd) {
    conditions.push(`created_at <= $${idx++}::timestamptz`);
    params.push(opts.periodEnd);
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

  const sql = `
    SELECT
      provider,
      model_id,
      COUNT(*) AS call_count,
      SUM(tokens_input) AS tokens_input,
      SUM(tokens_output) AS tokens_output,
      SUM(tokens_cache_read) AS tokens_cache_read,
      SUM(tokens_cache_write) AS tokens_cache_write,
      SUM(tokens_reasoning) AS tokens_reasoning
    FROM ${TABLE}
    ${where}
    GROUP BY provider, model_id
    ORDER BY provider, model_id
  `;

  const result = await s.query(sql, params);
  return result.rows.map((r) => ({
    provider: r.provider,
    modelId: r.model_id,
    callCount: Number(r.call_count),
    tokensInput: Number(r.tokens_input),
    tokensOutput: Number(r.tokens_output),
    tokensCacheRead: Number(r.tokens_cache_read),
    tokensCacheWrite: Number(r.tokens_cache_write),
    tokensReasoning: Number(r.tokens_reasoning || 0),
  }));
}

/**
 * Get grand totals for a period.
 * @param {object} opts - Same as getAggregatedTokenUsage
 * @returns {Promise<{callCount: number, tokensInput: number, tokensOutput: number, tokensCacheRead: number, tokensCacheWrite: number, tokensReasoning: number}>}
 */
export async function getTokenTotals(opts = {}) {
  const s = await getStore();

  if (s.driver === 'file') {
    return s.localStore.getTotals(opts);
  }

  const conditions = [];
  const params = [];
  let idx = 1;

  if (opts.periodStart) {
    conditions.push(`created_at >= $${idx++}::timestamptz`);
    params.push(opts.periodStart);
  }
  if (opts.periodEnd) {
    conditions.push(`created_at <= $${idx++}::timestamptz`);
    params.push(opts.periodEnd);
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

  const sql = `
    SELECT
      COUNT(*) AS call_count,
      SUM(tokens_input) AS tokens_input,
      SUM(tokens_output) AS tokens_output,
      SUM(tokens_cache_read) AS tokens_cache_read,
      SUM(tokens_cache_write) AS tokens_cache_write,
      SUM(tokens_reasoning) AS tokens_reasoning
    FROM ${TABLE}
    ${where}
  `;

  const result = await s.query(sql, params);
  const r = result.rows[0] || {};
  return {
    callCount: Number(r.call_count || 0),
    tokensInput: Number(r.tokens_input || 0),
    tokensOutput: Number(r.tokens_output || 0),
    tokensCacheRead: Number(r.tokens_cache_read || 0),
    tokensCacheWrite: Number(r.tokens_cache_write || 0),
    tokensReasoning: Number(r.tokens_reasoning || 0),
  };
}
