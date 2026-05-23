/**
 * settings.js — REST API for model pricing settings
 *
 * Routes:
 *   GET    /api/companies/:companyId/pricing/settings       — List all settings
 *   GET    /api/companies/:companyId/pricing/settings/:id   — Get single setting
 *   POST   /api/companies/:companyId/pricing/settings       — Create/upsert a setting
 *   PUT    /api/companies/:companyId/pricing/settings/:id   — Update a setting
 *   POST   /api/companies/:companyId/pricing/backfill       — Auto-create settings for models missing them
 */

import { Router } from 'express';
import {
  getPricingSettings,
  getPricingSettingByModel,
  upsertPricingSetting,
  updatePricingSetting,
  getDistinctModelsFromTokenLedger,
} from './schema.js';

const router = Router();

/**
 * GET /api/companies/:companyId/pricing/settings
 *
 * Query params:
 *   provider  — optional filter by provider
 *   model_id  — optional filter by model_id
 */
router.get('/api/companies/:companyId/pricing/settings', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { provider, model_id } = req.query;

    const settings = await getPricingSettings({
      companyId,
      provider: provider || undefined,
      modelId: model_id || undefined,
    });

    return res.json({ settings });
  } catch (err) {
    console.error('GET /pricing/settings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/companies/:companyId/pricing/settings/:id
 */
router.get('/api/companies/:companyId/pricing/settings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const settings = await getPricingSettings({});
    const setting = settings.find(s => s.id === id);
    if (!setting) {
      return res.status(404).json({ error: 'Pricing setting not found' });
    }
    return res.json({ setting });
  } catch (err) {
    console.error('GET /pricing/settings/:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/companies/:companyId/pricing/settings
 *
 * Create or upsert a pricing setting.
 * If a row already exists for (company_id, provider, model_id), it is updated.
 *
 * Body:
 *   provider          (string, required)
 *   model_id          (string, required)
 *   cost_per_input_token     (number, optional, default 0)
 *   cost_per_output_token    (number, optional, default 0)
 *   cost_per_cache_read_token  (number|null, optional, default 0)
 *   cost_per_cache_write_token (number|null, optional, default 0)
 *   label             (string, optional)
 */
router.post('/api/companies/:companyId/pricing/settings', async (req, res) => {
  try {
    const { companyId } = req.params;
    const {
      provider,
      model_id,
      cost_per_input_token,
      cost_per_output_token,
      cost_per_cache_read_token,
      cost_per_cache_write_token,
      label,
    } = req.body || {};

    // --- Validation ---
    if (!provider || typeof provider !== 'string') {
      return res.status(400).json({ error: 'provider is required and must be a string' });
    }
    if (!model_id || typeof model_id !== 'string') {
      return res.status(400).json({ error: 'model_id is required and must be a string' });
    }

    const setting = await upsertPricingSetting({
      companyId,
      provider: provider.toLowerCase(),
      modelId: model_id,
      costPerInputToken: cost_per_input_token != null ? Number(cost_per_input_token) : 0,
      costPerOutputToken: cost_per_output_token != null ? Number(cost_per_output_token) : 0,
      costPerCacheReadToken: cost_per_cache_read_token != null ? Number(cost_per_cache_read_token) : 0,
      costPerCacheWriteToken: cost_per_cache_write_token != null ? Number(cost_per_cache_write_token) : 0,
      label: label || null,
      isDefault: false, // explicitly created by user
    });

    return res.status(201).json({ setting });
  } catch (err) {
    console.error('POST /pricing/settings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/companies/:companyId/pricing/settings/:id
 *
 * Partially update a pricing setting.
 *
 * Body (all optional):
 *   cost_per_input_token     (number)
 *   cost_per_output_token    (number)
 *   cost_per_cache_read_token  (number|null)
 *   cost_per_cache_write_token (number|null)
 *   label             (string)
 */
router.put('/api/companies/:companyId/pricing/settings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      cost_per_input_token,
      cost_per_output_token,
      cost_per_cache_read_token,
      cost_per_cache_write_token,
      label,
      is_default,
    } = req.body || {};

    // Build updates object
    const updates = {};
    if (cost_per_input_token !== undefined) updates.costPerInputToken = Number(cost_per_input_token);
    if (cost_per_output_token !== undefined) updates.costPerOutputToken = Number(cost_per_output_token);
    if (cost_per_cache_read_token !== undefined) updates.costPerCacheReadToken = cost_per_cache_read_token === null ? null : Number(cost_per_cache_read_token);
    if (cost_per_cache_write_token !== undefined) updates.costPerCacheWriteToken = cost_per_cache_write_token === null ? null : Number(cost_per_cache_write_token);
    if (label !== undefined) updates.label = label;
    if (is_default !== undefined) updates.isDefault = is_default;

    // If updating costs, mark as not default
    if (cost_per_input_token !== undefined || cost_per_output_token !== undefined) {
      updates.isDefault = false;
    }

    const setting = await updatePricingSetting(id, updates);

    if (!setting) {
      return res.status(404).json({ error: 'Pricing setting not found' });
    }

    return res.json({ setting });
  } catch (err) {
    console.error('PUT /pricing/settings/:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/companies/:companyId/pricing/backfill
 *
 * Auto-creates pricing settings (default 0) for every (provider, model_id)
 * combination present in model_token_ledger that doesn't already have a
 * pricing setting.
 *
 * Returns the count of newly created settings.
 */
router.post('/api/companies/:companyId/pricing/backfill', async (req, res) => {
  try {
    const { companyId } = req.params;

    const missingModels = await getDistinctModelsFromTokenLedger(companyId);
    let created = 0;

    for (const row of missingModels) {
      await upsertPricingSetting({
        companyId,
        provider: row.provider,
        modelId: row.model_id,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        costPerCacheReadToken: 0,
        costPerCacheWriteToken: 0,
        isDefault: true,
        label: `Auto-created from token ledger`,
      });
      created++;
    }

    return res.json({ backfilled: created, total: missingModels.length });
  } catch (err) {
    console.error('POST /pricing/backfill error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
