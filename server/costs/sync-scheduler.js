// server/costs/sync-scheduler.js — Runs all provider fetchers and writes results to DB
//
// Data flow for Cost Ledger token surface:
// 1. Provider billing API fetchers try to get cost/token data from provider APIs
// 2. If billing API is unavailable (no credentials, endpoint not available):
//    a. Query agent_token_usage for real runtime token counts
//    b. Generate estimated cost records using model pricing table
//    c. Source is marked 'paperclip_usage' for real runtime data
//    d. If no runtime data either, fall back to batch_sessions with source='paperclip_estimated'

import { AnthropicFetcher } from './fetchers/anthropic.js';
import { OpenAIFetcher } from './fetchers/openai.js';
import { DeepSeekFetcher } from './fetchers/deepseek.js';
import { BedrockFetcher } from './fetchers/bedrock.js';
import { upsertCostRecord, queryCostRecords } from './schema.js';
import { createEstimatedRecord, getKnownModelsByProvider } from './estimation-fallback.js';
import { query } from '../../db/client.js';
import { getAggregatedTokenUsage } from '../tokens/agent-token-service.js';

const DEFAULT_DAYS_BACK = 30;

/**
 * Run all configured provider fetchers and sync results to the DB.
 *
 * @param {Object} [opts]
 * @param {number} [opts.daysBack=30] - How many days to look back
 * @param {string[]} [opts.providers] - Specific providers to sync (default: all)
 * @returns {Promise<{results: Array<{provider: string, recordsCount: number, error: string|null, syncStatus: string}>}>}
 */
export async function syncAllProviders(opts = {}) {
  const daysBack = opts.daysBack ?? DEFAULT_DAYS_BACK;
  const periodEnd = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - daysBack);

  const fetchers = _createFetchers(opts.providers);
  const results = [];

  for (const fetcher of fetchers) {
    const result = await _runFetcher(fetcher, periodStart, periodEnd);
    results.push(result);
  }

  // Run estimation fallback for providers that had no billing data
  const failedProviders = results
    .filter(r => r.syncStatus === 'unavailable' || r.syncStatus === 'error')
    .map(r => r.provider);

  if (failedProviders.length > 0) {
    console.log(`[costs] running estimation fallback for: ${failedProviders.join(', ')}`);
    const fallbackResults = await runEstimationFallback({
      ...opts,
      providers: failedProviders,
      daysBack,
    });
    results.push(...fallbackResults);
  }

  return results;
}

/**
 * Sync a specific provider.
 * @param {string} providerName
 * @param {Object} [opts]
 * @param {number} [opts.daysBack=30]
 * @returns {Promise<{provider: string, recordsCount: number, error: string|null, syncStatus: string}>}
 */
export async function syncProvider(providerName, opts = {}) {
  const daysBack = opts.daysBack ?? DEFAULT_DAYS_BACK;
  const periodEnd = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - daysBack);

  const fetchers = _createFetchers([providerName]);
  if (fetchers.length === 0) {
    return {
      provider: providerName,
      recordsCount: 0,
      error: `Unknown provider: ${providerName}`,
      syncStatus: 'error',
    };
  }

  return _runFetcher(fetchers[0], periodStart, periodEnd);
}

/**
 * Run estimation fallback for providers where billing API data is unavailable.
 * Uses Paperclip token usage from agent_token_usage to generate estimated records.
 * Primary data source is agent_token_usage; batch_sessions fallback is used
 * only when no token records exist.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.providers] - Providers to estimate (default: all known)
 * @param {number} [opts.daysBack=30]
 * @returns {Promise<Array<{provider: string, recordsCount: number}>>}
 */
export async function runEstimationFallback(opts = {}) {
  const daysBack = opts.daysBack ?? DEFAULT_DAYS_BACK;
  const periodEnd = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - daysBack);
  const periodStartStr = periodStart.toISOString().slice(0, 10);
  const periodEndStr = periodEnd.toISOString().slice(0, 10);

  const providers = opts.providers || ['anthropic', 'openai', 'deepseek', 'bedrock'];
  const results = [];

  for (const provider of providers) {
    try {
      // Check if we have billing API records for this provider in the period
      const billingRecords = await queryCostRecords({
        periodStart: periodStartStr,
        periodEnd: periodEndStr,
        providers: [provider],
        source: 'provider_billing_api',
      });

      if (billingRecords.length > 0) {
        // Provider has billing data — skip estimation for covered periods
        results.push({ provider, recordsCount: 0, note: 'billing data exists' });
        continue;
      }

      // STEP 1: Query agent_token_usage for real token counts aggregated by model
      let tokenUsageByModel = [];
      try {
        tokenUsageByModel = await getAggregatedTokenUsage({
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          provider,
        });
      } catch (tokenErr) {
        console.warn(`[costs] could not query agent_token_usage: ${tokenErr.message}`);
      }

      if (tokenUsageByModel.length > 0) {
        // Use real token counts from agent runtime — source: paperclip_usage
        let createdCount = 0;
        for (const modelTokens of tokenUsageByModel) {
          const record = createEstimatedRecord({
            provider,
            modelId: modelTokens.modelId,
            periodStart: periodStartStr,
            periodEnd: periodEndStr,
            usage: {
              tokensInput: modelTokens.tokensInput,
              tokensOutput: modelTokens.tokensOutput,
              tokensCacheRead: modelTokens.tokensCacheRead,
              tokensCacheWrite: modelTokens.tokensCacheWrite,
              runCount: modelTokens.callCount,
            },
          });

          if (record) {
            // Override source to make clear this is from runtime usage data
            record.source = 'paperclip_usage';
            try {
              await upsertCostRecord(record);
              createdCount++;
            } catch (upsertErr) {
              console.error(`[costs] failed to upsert token-derived record for ${provider}/${modelTokens.modelId}:`, upsertErr.message);
            }
          }
        }
        results.push({
          provider,
          recordsCount: createdCount,
          note: `created ${createdCount} records from agent_token_usage (${tokenUsageByModel.reduce((s, m) => s + m.callCount, 0)} calls)`,
        });
        continue;
      }

      // STEP 2: No token usage data — fall back to batch_sessions for aggregate run counts
      let sessionData = null;
      try {
        const sessionSql = `
          SELECT COUNT(*)::int AS session_count, COALESCE(SUM(turns), 0)::int AS total_turns
          FROM batch_sessions
          WHERE finished_at >= $1 AND finished_at <= $2
        `;
        const sessionResult = await query(sessionSql, [
          periodStart.toISOString(),
          periodEnd.toISOString(),
        ]);
        sessionData = sessionResult.rows[0] || { session_count: 0, total_turns: 0 };
      } catch (dbErr) {
        console.warn(`[costs] could not query batch_sessions: ${dbErr.message}`);
        sessionData = { session_count: 0, total_turns: 0 };
      }

      // Generate estimated records for each known model of this provider
      const knownModels = getKnownModelsByProvider()[provider] || [];
      let createdCount = 0;

      for (const modelId of knownModels) {
        const record = createEstimatedRecord({
          provider,
          modelId,
          periodStart: periodStartStr,
          periodEnd: periodEndStr,
          usage: {
            tokensInput: 0,
            tokensOutput: 0,
            tokensCacheRead: 0,
            tokensCacheWrite: 0,
            runCount: sessionData ? sessionData.total_turns : null,
          },
        });

        if (record) {
          try {
            await upsertCostRecord(record);
            createdCount++;
          } catch (upsertErr) {
            console.error(`[costs] failed to upsert estimated record for ${provider}/${modelId}:`, upsertErr.message);
          }
        }
      }

      results.push({
        provider,
        recordsCount: createdCount,
        note: createdCount > 0
          ? `created ${createdCount} estimated records (sessions: ${sessionData?.session_count ?? 0}, turns: ${sessionData?.total_turns ?? 0})`
          : 'no models known for provider',
      });
    } catch (err) {
      console.error(`[costs] estimation fallback error for ${provider}:`, err.message);
      results.push({ provider, recordsCount: 0, error: err.message });
    }
  }

  return results;
}

/**
 * Get sync status summary for all providers.
 * @param {Object} [opts]
 * @param {number} [opts.daysBack=7]
 * @returns {Promise<Object>}
 */
export async function getSyncStatusSummary(opts = {}) {
  const daysBack = opts.daysBack ?? 7;
  const periodEnd = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - daysBack);

  const providers = ['anthropic', 'openai', 'deepseek', 'bedrock'];
  const summary = {};

  for (const provider of providers) {
    const records = await queryCostRecords({
      periodStart: periodStart.toISOString().slice(0, 10),
      periodEnd: periodEnd.toISOString().slice(0, 10),
      providers: [provider],
    });

    const billingRecords = records.filter((r) => r.source === 'provider_billing_api');
    const estimatedRecords = records.filter((r) => r.source === 'paperclip_estimated' || r.source === 'paperclip_usage');

    summary[provider] = {
      hasBillingData: billingRecords.length > 0,
      billingRecordsCount: billingRecords.length,
      estimatedRecordsCount: estimatedRecords.length,
      lastSyncAt: billingRecords.length > 0
        ? billingRecords[billingRecords.length - 1].lastSyncedAt
        : null,
      latestSyncStatus: billingRecords.length > 0
        ? billingRecords[billingRecords.length - 1].syncStatus
        : 'unavailable',
    };
  }

  return summary;
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function _createFetchers(providersFilter) {
  const all = {
    anthropic: new AnthropicFetcher(),
    openai: new OpenAIFetcher(),
    deepseek: new DeepSeekFetcher(),
    bedrock: new BedrockFetcher(),
  };

  if (providersFilter && providersFilter.length > 0) {
    return providersFilter
      .filter((p) => all[p])
      .map((p) => all[p]);
  }

  return Object.values(all);
}

async function _runFetcher(fetcher, periodStart, periodEnd) {
  const providerName = fetcher.providerName;
  console.log(`[costs] syncing ${providerName} from ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`);

  try {
    if (fetcher.requiresCredential() && !fetcher._credentialsAvailable()) {
      console.warn(`[costs] ${providerName}: credentials not configured, skipping`);
      // Mark as unavailable in ledger
      await upsertCostRecord({
        provider: providerName,
        modelId: '_summary',
        periodStart: periodStart.toISOString().slice(0, 10),
        periodEnd: periodEnd.toISOString().slice(0, 10),
        amount: 0,
        currency: 'USD',
        source: 'provider_billing_api',
        syncStatus: 'unavailable',
        syncError: 'Credentials not configured',
        isVerified: false,
        lastSyncedAt: new Date().toISOString(),
      });
      return {
        provider: providerName,
        recordsCount: 0,
        error: null,
        syncStatus: 'unavailable',
      };
    }

    const records = await fetcher.fetch(periodStart, periodEnd);
    let insertedCount = 0;

    for (const record of records) {
      await upsertCostRecord({
        ...record,
        syncStatus: 'fresh',
        lastSyncedAt: new Date().toISOString(),
      });
      insertedCount++;
    }

    console.log(`[costs] ${providerName}: synced ${insertedCount} records`);
    return {
      provider: providerName,
      recordsCount: insertedCount,
      error: null,
      syncStatus: 'fresh',
    };
  } catch (err) {
    const status = err.status;
    let syncStatus = 'error';
    if (status === 401 || status === 403) {
      syncStatus = 'unavailable';
    } else if (status === 429) {
      syncStatus = 'stale';
    } else if (err.endpointNotAvailable || status === 404) {
      syncStatus = 'unavailable';
    }

    console.error(`[costs] ${providerName} sync error (${syncStatus}):`, err.message);

    // Record the error state in the ledger
    try {
      await upsertCostRecord({
        provider: providerName,
        modelId: '_summary',
        periodStart: periodStart.toISOString().slice(0, 10),
        periodEnd: periodEnd.toISOString().slice(0, 10),
        amount: 0,
        currency: 'USD',
        source: 'provider_billing_api',
        syncStatus,
        syncError: err.message,
        isVerified: false,
        lastSyncedAt: new Date().toISOString(),
      });
    } catch (dbErr) {
      console.error(`[costs] ${providerName}: failed to record error state:`, dbErr.message);
    }

    return {
      provider: providerName,
      recordsCount: 0,
      error: err.message,
      syncStatus,
    };
  }
}
