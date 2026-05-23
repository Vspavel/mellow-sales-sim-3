// server/costs/schema.js — ProviderCostRecord DB access

import { query } from '../../db/client.js';
import crypto from 'crypto';

const TABLE = 'provider_cost_ledger';

/**
 * @typedef {Object} ProviderCostRecord
 * @property {string} id
 * @property {string} provider
 * @property {string} modelId
 * @property {string} periodStart
 * @property {string} periodEnd
 * @property {number} amount
 * @property {string} currency
 * @property {number|null} tokensInput
 * @property {number|null} tokensOutput
 * @property {number|null} tokensCacheRead
 * @property {number|null} tokensCacheWrite
 * @property {number|null} runCount
 * @property {string} source - 'provider_billing_api' | 'paperclip_estimated' | 'paperclip_usage'
 * @property {string} syncStatus - 'fresh' | 'stale' | 'unavailable' | 'error'
 * @property {string|null} lastSyncedAt
 * @property {string|null} syncError
 * @property {boolean} isVerified
 * @property {string|null} providerAccountLabel
 * @property {number|null} estimatedInputPricePerM
 * @property {number|null} estimatedOutputPricePerM
 * @property {string} createdAt
 * @property {string} updatedAt
 */

function rowToRecord(row) {
  return {
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    periodStart: row.period_start instanceof Date ? row.period_start.toISOString().slice(0, 10) : String(row.period_start).slice(0, 10),
    periodEnd: row.period_end instanceof Date ? row.period_end.toISOString().slice(0, 10) : String(row.period_end).slice(0, 10),
    amount: Number(row.amount),
    currency: row.currency,
    tokensInput: row.tokens_input != null ? Number(row.tokens_input) : null,
    tokensOutput: row.tokens_output != null ? Number(row.tokens_output) : null,
    tokensCacheRead: row.tokens_cache_read != null ? Number(row.tokens_cache_read) : null,
    tokensCacheWrite: row.tokens_cache_write != null ? Number(row.tokens_cache_write) : null,
    runCount: row.run_count != null ? Number(row.run_count) : null,
    source: row.source,
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null,
    syncError: row.sync_error,
    isVerified: row.is_verified,
    providerAccountLabel: row.provider_account_label,
    estimatedInputPricePerM: row.estimated_input_price_per_m != null ? Number(row.estimated_input_price_per_m) : null,
    estimatedOutputPricePerM: row.estimated_output_price_per_m != null ? Number(row.estimated_output_price_per_m) : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function generateId() {
  return crypto.randomUUID();
}

/**
 * Insert or update a provider cost record (upsert on provider+model_id+period_start+source).
 * Supports both company-scoped and global records via company_id field.
 * @param {ProviderCostRecord} record
 */
export async function upsertCostRecord(record) {
  const id = record.id || generateId();
  const hasCompanyId = record.companyId != null;
  const sql = hasCompanyId
    ? `
    INSERT INTO ${TABLE} (id, company_id, provider, model_id, period_start, period_end, amount, currency,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, run_count,
      source, sync_status, last_synced_at, sync_error, is_verified, provider_account_label,
      estimated_input_price_per_m, estimated_output_price_per_m, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19,
      $20, $21, NOW(), NOW())
    ON CONFLICT (company_id, provider, model_id, period_start, source)
    DO UPDATE SET
      period_end = EXCLUDED.period_end,
      amount = EXCLUDED.amount,
      tokens_input = EXCLUDED.tokens_input,
      tokens_output = EXCLUDED.tokens_output,
      tokens_cache_read = EXCLUDED.tokens_cache_read,
      tokens_cache_write = EXCLUDED.tokens_cache_write,
      run_count = EXCLUDED.run_count,
      sync_status = EXCLUDED.sync_status,
      last_synced_at = EXCLUDED.last_synced_at,
      sync_error = EXCLUDED.sync_error,
      is_verified = EXCLUDED.is_verified,
      provider_account_label = EXCLUDED.provider_account_label,
      estimated_input_price_per_m = EXCLUDED.estimated_input_price_per_m,
      estimated_output_price_per_m = EXCLUDED.estimated_output_price_per_m,
      updated_at = NOW()
    RETURNING *
  `
    : `
    INSERT INTO ${TABLE} (id, provider, model_id, period_start, period_end, amount, currency,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, run_count,
      source, sync_status, last_synced_at, sync_error, is_verified, provider_account_label,
      estimated_input_price_per_m, estimated_output_price_per_m, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12,
      $13, $14, $15, $16, $17, $18,
      $19, $20, NOW(), NOW())
    ON CONFLICT (provider, model_id, period_start, source)
    DO UPDATE SET
      period_end = EXCLUDED.period_end,
      amount = EXCLUDED.amount,
      tokens_input = EXCLUDED.tokens_input,
      tokens_output = EXCLUDED.tokens_output,
      tokens_cache_read = EXCLUDED.tokens_cache_read,
      tokens_cache_write = EXCLUDED.tokens_cache_write,
      run_count = EXCLUDED.run_count,
      sync_status = EXCLUDED.sync_status,
      last_synced_at = EXCLUDED.last_synced_at,
      sync_error = EXCLUDED.sync_error,
      is_verified = EXCLUDED.is_verified,
      provider_account_label = EXCLUDED.provider_account_label,
      estimated_input_price_per_m = EXCLUDED.estimated_input_price_per_m,
      estimated_output_price_per_m = EXCLUDED.estimated_output_price_per_m,
      updated_at = NOW()
    RETURNING *
  `;

  let params;
  if (hasCompanyId) {
    params = [
      id, record.companyId, record.provider, record.modelId, record.periodStart, record.periodEnd,
      record.amount, record.currency || 'USD',
      record.tokensInput ?? null, record.tokensOutput ?? null,
      record.tokensCacheRead ?? null, record.tokensCacheWrite ?? null,
      record.runCount ?? null,
      record.source, record.syncStatus || 'fresh',
      record.lastSyncedAt ?? null, record.syncError ?? null,
      record.isVerified !== false, record.providerAccountLabel ?? null,
      record.estimatedInputPricePerM ?? null, record.estimatedOutputPricePerM ?? null,
    ];
  } else {
    params = [
      id, record.provider, record.modelId, record.periodStart, record.periodEnd,
      record.amount, record.currency || 'USD',
      record.tokensInput ?? null, record.tokensOutput ?? null,
      record.tokensCacheRead ?? null, record.tokensCacheWrite ?? null,
      record.runCount ?? null,
      record.source, record.syncStatus || 'fresh',
      record.lastSyncedAt ?? null, record.syncError ?? null,
      record.isVerified !== false, record.providerAccountLabel ?? null,
      record.estimatedInputPricePerM ?? null, record.estimatedOutputPricePerM ?? null,
    ];
  }
  const result = await query(sql, params);
  return rowToRecord(result.rows[0]);
}

/**
 * Query cost records with optional filters.
 * @param {Object} opts
 * @param {string} [opts.periodStart]
 * @param {string} [opts.periodEnd]
 * @param {string[]} [opts.providers]
 * @param {string} [opts.modelId]
 * @param {string} [opts.source]
 * @param {number} [opts.limit]
 */
export async function queryCostRecords(opts = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (opts.periodStart) {
    conditions.push(`period_start >= $${idx++}`);
    params.push(opts.periodStart);
  }
  if (opts.periodEnd) {
    conditions.push(`period_end <= $${idx++}`);
    params.push(opts.periodEnd);
  }
  if (opts.providers && opts.providers.length > 0) {
    conditions.push(`provider = ANY($${idx++})`);
    params.push(opts.providers);
  }
  if (opts.modelId) {
    conditions.push(`model_id = $${idx++}`);
    params.push(opts.modelId);
  }
  if (opts.source) {
    conditions.push(`source = $${idx++}`);
    params.push(opts.source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM ${TABLE} ${where} ORDER BY provider, period_start DESC`;
  const result = await query(sql, params);
  return result.rows.map(rowToRecord);
}

/**
 * Delete old records beyond a retention period.
 * @param {number} retentionDays
 */
export async function pruneCostRecords(retentionDays = 365) {
  const sql = `DELETE FROM ${TABLE} WHERE period_start < NOW() - INTERVAL '1 day' * $1`;
  const result = await query(sql, [retentionDays]);
  return result.rowCount;
}

/**
 * Get summary statistics across queried records.
 * @param {Object} opts same as queryCostRecords
 */
export async function getCostSummary(opts = {}) {
  const records = await queryCostRecords(opts);
  const totalAmount = records.reduce((sum, r) => sum + r.amount, 0);
  const byProvider = {};
  let estimatedOnlyAmount = 0;
  const providersWithData = new Set();
  const providersMissing = new Set();

  for (const r of records) {
    byProvider[r.provider] = (byProvider[r.provider] || 0) + r.amount;
    if (r.source === 'paperclip_estimated' || r.source === 'paperclip_usage') {
      estimatedOnlyAmount += r.amount;
    }
    if (r.source === 'provider_billing_api') {
      providersWithData.add(r.provider);
    }
  }

  // Determine which providers are missing (queried but no billing_api records)
  if (opts.providers && opts.providers.length > 0) {
    for (const p of opts.providers) {
      if (!providersWithData.has(p)) {
        providersMissing.add(p);
      }
    }
  }

  return {
    totalAmount: Math.round(totalAmount * 100) / 100,
    byProvider: Object.fromEntries(
      Object.entries(byProvider).map(([k, v]) => [k, Math.round(v * 100) / 100])
    ),
    estimatedOnlyAmount: Math.round(estimatedOnlyAmount * 100) / 100,
    unavailableProviderCount: providersMissing.size,
  };
}
