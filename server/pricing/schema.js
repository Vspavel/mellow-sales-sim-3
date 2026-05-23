/**
 * schema.js — CRUD operations for model_pricing_settings
 */

import { query } from '../../db/client.js';
import crypto from 'crypto';

function uuid() {
  return crypto.randomUUID();
}

/**
 * upsertPricingSetting — Create or update a pricing row.
 * Uses ON CONFLICT on (company_id, provider, model_id) to upsert.
 *
 * @param {object} params
 * @param {string} params.companyId
 * @param {string} params.provider
 * @param {string} params.modelId
 * @param {number} [params.costPerInputToken]
 * @param {number} [params.costPerOutputToken]
 * @param {number|null} [params.costPerCacheReadToken]
 * @param {number|null} [params.costPerCacheWriteToken]
 * @param {string} [params.label]
 * @param {boolean} [params.isDefault]
 * @returns {Promise<object>} The upserted row
 */
export async function upsertPricingSetting({
  companyId,
  provider,
  modelId,
  costPerInputToken = 0,
  costPerOutputToken = 0,
  costPerCacheReadToken = 0,
  costPerCacheWriteToken = 0,
  label = null,
  isDefault = true,
}) {
  const id = uuid();
  const result = await query(
    `INSERT INTO model_pricing_settings
       (id, company_id, provider, model_id,
        cost_per_input_token, cost_per_output_token,
        cost_per_cache_read_token, cost_per_cache_write_token,
        label, is_default, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (company_id, provider, model_id)
     DO UPDATE SET
       cost_per_input_token       = COALESCE(EXCLUDED.cost_per_input_token, model_pricing_settings.cost_per_input_token),
       cost_per_output_token      = COALESCE(EXCLUDED.cost_per_output_token, model_pricing_settings.cost_per_output_token),
       cost_per_cache_read_token  = COALESCE(EXCLUDED.cost_per_cache_read_token, model_pricing_settings.cost_per_cache_read_token),
       cost_per_cache_write_token = COALESCE(EXCLUDED.cost_per_cache_write_token, model_pricing_settings.cost_per_cache_write_token),
       label                      = COALESCE(EXCLUDED.label, model_pricing_settings.label),
       is_default                 = EXCLUDED.is_default,
       updated_at                 = NOW()
     RETURNING *`,
    [
      id, companyId, provider, modelId,
      costPerInputToken, costPerOutputToken,
      costPerCacheReadToken, costPerCacheWriteToken,
      label, isDefault,
    ]
  );
  return result.rows[0];
}

/**
 * getPricingSettings — List pricing settings for a company, with optional filters.
 *
 * @param {object} filters
 * @param {string} [filters.companyId]
 * @param {string} [filters.provider]
 * @param {string} [filters.modelId]
 * @returns {Promise<object[]>}
 */
export async function getPricingSettings(filters = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (filters.companyId) {
    conditions.push(`company_id = $${idx++}`);
    params.push(filters.companyId);
  }
  if (filters.provider) {
    conditions.push(`provider = $${idx++}`);
    params.push(filters.provider);
  }
  if (filters.modelId) {
    conditions.push(`model_id = $${idx++}`);
    params.push(filters.modelId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query(
    `SELECT * FROM model_pricing_settings ${where} ORDER BY provider, model_id`,
    params
  );
  return result.rows;
}

/**
 * updatePricingSetting — Update a specific pricing setting by ID.
 *
 * @param {string} id
 * @param {object} updates - fields to update
 * @returns {Promise<object|null>} The updated row, or null if not found
 */
export async function updatePricingSetting(id, updates) {
  const fields = [];
  const params = [];
  let idx = 1;

  if (updates.costPerInputToken !== undefined) {
    fields.push(`cost_per_input_token = $${idx++}`);
    params.push(updates.costPerInputToken);
  }
  if (updates.costPerOutputToken !== undefined) {
    fields.push(`cost_per_output_token = $${idx++}`);
    params.push(updates.costPerOutputToken);
  }
  if (updates.costPerCacheReadToken !== undefined) {
    fields.push(`cost_per_cache_read_token = $${idx++}`);
    params.push(updates.costPerCacheReadToken);
  }
  if (updates.costPerCacheWriteToken !== undefined) {
    fields.push(`cost_per_cache_write_token = $${idx++}`);
    params.push(updates.costPerCacheWriteToken);
  }
  if (updates.label !== undefined) {
    fields.push(`label = $${idx++}`);
    params.push(updates.label);
  }
  if (updates.isDefault !== undefined) {
    fields.push(`is_default = $${idx++}`);
    params.push(updates.isDefault);
  }

  if (fields.length === 0) {
    throw new Error('No valid fields to update');
  }

  fields.push('updated_at = NOW()');
  params.push(id);

  const result = await query(
    `UPDATE model_pricing_settings SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

/**
 * getPricingSettingByModel — Get a single pricing setting for a specific model.
 *
 * @param {string} companyId
 * @param {string} provider
 * @param {string} modelId
 * @returns {Promise<object|null>}
 */
export async function getPricingSettingByModel(companyId, provider, modelId) {
  const result = await query(
    `SELECT * FROM model_pricing_settings WHERE company_id = $1 AND provider = $2 AND model_id = $3`,
    [companyId, provider, modelId]
  );
  return result.rows[0] || null;
}

/**
 * getDistinctModelsFromTokenLedger — Get all distinct (provider, model_id) pairs
 * from model_token_ledger that don't yet have a pricing setting.
 *
 * @param {string} companyId
 * @returns {Promise<{provider: string, model_id: string}[]>}
 */
export async function getDistinctModelsFromTokenLedger(companyId) {
  const result = await query(
    `SELECT DISTINCT mtl.provider, mtl.model_id
     FROM model_token_ledger mtl
     WHERE mtl.company_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM model_pricing_settings mps
         WHERE mps.company_id = mtl.company_id
           AND mps.provider = mtl.provider
           AND mps.model_id = mtl.model_id
       )`,
    [companyId]
  );
  return result.rows;
}
