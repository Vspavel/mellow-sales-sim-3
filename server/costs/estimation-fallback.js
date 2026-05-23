// server/costs/estimation-fallback.js — Token-based cost estimation using model registry

import crypto from 'crypto';

/**
 * Known model pricing as of 2026-05.
 * This is the fallback price table used when provider billing API data is unavailable.
 * Prices are in USD per million tokens.
 *
 * Sources:
 * - @mariozechner/pi-ai/dist/models.generated.ts
 * - Provider published pricing pages
 */
const MODEL_PRICES = {
  // Anthropic
  'claude-sonnet-4-6':      { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-6-swi':  { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4-5':        { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-haiku-3-5':       { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
  'claude-sonnet-3-5':      { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4':          { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-haiku-3':         { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.30 },

  // OpenAI
  'gpt-4o':                 { input: 2.50, output: 10.00, cacheRead: 1.25, cacheWrite: 2.50 },
  'gpt-4o-mini':            { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0.15 },
  'gpt-4-turbo':            { input: 10.00, output: 30.00, cacheRead: null, cacheWrite: null },
  'gpt-4':                  { input: 30.00, output: 60.00, cacheRead: null, cacheWrite: null },
  'gpt-3.5-turbo':          { input: 0.50, output: 1.50, cacheRead: null, cacheWrite: null },

  // DeepSeek
  // V3 models — scheduled for deprecation 2026/07/24 per DeepSeek API docs
  'deepseek-chat':          { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-reasoner':      { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },

  // DeepSeek V4 (primary models, verified from api-docs.deepseek.com/quick_start/pricing)
  'deepseek-v4-flash':      { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: null },
  'deepseek-v4-pro':        { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: null },

  // Bedrock (Anthropic models via AWS)
  'bedrock-claude-sonnet-4-6':  { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'bedrock-claude-opus-4-5':    { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'bedrock-claude-haiku-3-5':   { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
};

/**
 * Default pricing for unknown models (used as fallback-of-last-resort).
 */
const DEFAULT_INPUT_PRICE = 3.00;
const DEFAULT_OUTPUT_PRICE = 15.00;

/**
 * Get pricing info for a model.
 * @param {string} modelId
 * @returns {{ input: number, output: number, cacheRead: number|null, cacheWrite: number|null }|null}
 */
export function getModelPricing(modelId) {
  return MODEL_PRICES[modelId] || null;
}

/**
 * Estimate cost from token usage using the model price table.
 * @param {Object} usage - Token usage counts
 * @param {number} usage.tokensInput
 * @param {number} usage.tokensOutput
 * @param {number} [usage.tokensCacheRead]
 * @param {number} [usage.tokensCacheWrite]
 * @param {string} modelId - Model identifier (looked up in MODEL_PRICES)
 * @returns {{ amount: number, inputPricePerM: number, outputPricePerM: number }|null}
 *   Returns null if no pricing info found.
 */
export function estimateCost(usage, modelId) {
  const pricing = getModelPricing(modelId);
  if (!pricing) return null;

  const tokensInput = usage.tokensInput || 0;
  const tokensOutput = usage.tokensOutput || 0;
  const tokensCacheRead = usage.tokensCacheRead || 0;
  const tokensCacheWrite = usage.tokensCacheWrite || 0;

  const inputCost = (pricing.input / 1_000_000) * tokensInput;
  const outputCost = (pricing.output / 1_000_000) * tokensOutput;
  const cacheReadCost = pricing.cacheRead != null ? (pricing.cacheRead / 1_000_000) * tokensCacheRead : 0;
  const cacheWriteCost = pricing.cacheWrite != null ? (pricing.cacheWrite / 1_000_000) * tokensCacheWrite : 0;

  return {
    amount: Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 1000000) / 1000000,
    inputPricePerM: pricing.input,
    outputPricePerM: pricing.output,
  };
}

/**
 * Create an estimated ProviderCostRecord from token usage data.
 * This is used when provider billing API data is unavailable.
 *
 * @param {Object} opts
 * @param {string} opts.provider
 * @param {string} opts.modelId
 * @param {string} opts.periodStart
 * @param {string} opts.periodEnd
 * @param {Object} opts.usage - Token usage counts
 * @param {number} opts.usage.tokensInput
 * @param {number} opts.usage.tokensOutput
 * @param {number} [opts.usage.tokensCacheRead]
 * @param {number} [opts.usage.tokensCacheWrite]
 * @param {number} [opts.usage.runCount]
 * @returns {Object|null} ProviderCostRecord-like object, or null if pricing unknown
 */
export function createEstimatedRecord(opts) {
  const estimation = estimateCost(opts.usage, opts.modelId);
  if (!estimation) {
    // Fallback of last resort: use default prices
    const fallback = _fallbackEstimate(opts);
    if (!fallback) return null;
    return fallback;
  }

  return {
    provider: opts.provider,
    modelId: opts.modelId,
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    amount: estimation.amount,
    currency: 'USD',
    tokensInput: opts.usage.tokensInput ?? null,
    tokensOutput: opts.usage.tokensOutput ?? null,
    tokensCacheRead: opts.usage.tokensCacheRead ?? null,
    tokensCacheWrite: opts.usage.tokensCacheWrite ?? null,
    runCount: opts.usage.runCount ?? null,
    source: 'paperclip_estimated',
    isVerified: false,
    syncStatus: 'stale',
    providerAccountLabel: null,
    estimatedInputPricePerM: estimation.inputPricePerM,
    estimatedOutputPricePerM: estimation.outputPricePerM,
    lastSyncedAt: new Date().toISOString(),
  };
}

function _fallbackEstimate(opts) {
  const tokensInput = opts.usage.tokensInput || 0;
  const tokensOutput = opts.usage.tokensOutput || 0;
  const inputCost = (DEFAULT_INPUT_PRICE / 1_000_000) * tokensInput;
  const outputCost = (DEFAULT_OUTPUT_PRICE / 1_000_000) * tokensOutput;

  return {
    provider: opts.provider,
    modelId: opts.modelId,
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    amount: Math.round((inputCost + outputCost) * 1000000) / 1000000,
    currency: 'USD',
    tokensInput: opts.usage.tokensInput ?? null,
    tokensOutput: opts.usage.tokensOutput ?? null,
    tokensCacheRead: opts.usage.tokensCacheRead ?? null,
    tokensCacheWrite: opts.usage.tokensCacheWrite ?? null,
    runCount: opts.usage.runCount ?? null,
    source: 'paperclip_estimated',
    isVerified: false,
    syncStatus: 'unavailable',
    providerAccountLabel: null,
    estimatedInputPricePerM: DEFAULT_INPUT_PRICE,
    estimatedOutputPricePerM: DEFAULT_OUTPUT_PRICE,
    lastSyncedAt: new Date().toISOString(),
  };
}

/**
 * Get all model IDs known to the price table, grouped by provider.
 */
export function getKnownModelsByProvider() {
  const mapping = {
    anthropic: [],
    openai: [],
    deepseek: [],
    bedrock: [],
  };

  for (const [modelId, _pricing] of Object.entries(MODEL_PRICES)) {
    if (modelId.startsWith('claude-')) {
      mapping.anthropic.push(modelId);
    } else if (modelId.startsWith('gpt-')) {
      mapping.openai.push(modelId);
    } else if (modelId.startsWith('deepseek-')) {
      mapping.deepseek.push(modelId);
    } else if (modelId.startsWith('bedrock-')) {
      mapping.bedrock.push(modelId);
    }
  }

  return mapping;
}
