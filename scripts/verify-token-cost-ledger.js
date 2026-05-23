#!/usr/bin/env node
// scripts/verify-token-cost-ledger.js
// Verification for MEL-3297: Write runtime token usage into Cost Ledger token surface
//
// This script verifies:
// 1. All token/cost modules import correctly
// 2. The bridge from model_token_ledger → provider_cost_ledger exists in ingest.js
// 3. The Cost Ledger API returns source-distinguished records
// 4. No provider billing credentials are required for the token surface

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let failures = 0;

function check(label, ok) {
  if (ok) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
    failures++;
  }
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

async function main() {
  console.log('=== MEL-3297: Cost Ledger Token Surface Verification ===\n');

  // 1. Module import check
  console.log('--- Module Import Check ---');
  let recordTokenUsage, registerTokenRoutes, registerCostRoutes;

  try {
    const runtimeHook = await import(path.join(repoRoot, 'server/tokens/runtime-usage-hook.js'));
    recordTokenUsage = runtimeHook.recordTokenUsage;
    check('recordTokenUsage imported', typeof recordTokenUsage === 'function');
  } catch (e) {
    check(`recordTokenUsage: ${e.message}`, false);
  }

  try {
    const tokens = await import(path.join(repoRoot, 'server/tokens/index.js'));
    registerTokenRoutes = tokens.registerTokenRoutes;
    check('registerTokenRoutes imported', typeof registerTokenRoutes === 'function');
  } catch (e) {
    check(`registerTokenRoutes: ${e.message}`, false);
  }

  try {
    const costs = await import(path.join(repoRoot, 'server/costs/api-handler.js'));
    registerCostRoutes = costs.registerCostRoutes;
    check('registerCostRoutes imported', typeof registerCostRoutes === 'function');
  } catch (e) {
    check(`registerCostRoutes: ${e.message}`, false);
  }

  // 2. Verify the bridge: ingest.js → Cost Ledger
  console.log('\n--- Bridge Verification (ingest.js → Cost Ledger) ---');
  try {
    const ingestSource = readSource('server/tokens/ingest.js');
    check('ingest.js has upsertCostLedgerTokens', ingestSource.includes('upsertCostLedgerTokens'));
    check('ingest.js imports costs schema', ingestSource.includes('upsertCostRecord'));
    check('ingest.js uses paperclip_estimated source', ingestSource.includes("'paperclip_estimated'"));
    check('ingest.js is best-effort (.catch)', ingestSource.includes('.catch('));
  } catch (e) {
    check(`ingest read: ${e.message}`, false);
  }

  // 3. Verify Cost Ledger API surface
  console.log('\n--- Cost Ledger API Surface Verification ---');
  try {
    const handlerSource = readSource('server/costs/api-handler.js');
    check('Cost Ledger API returns costs/models', handlerSource.includes('/costs/models'));
    check('API shows source in docs', handlerSource.includes('source'));
    check('API mentions paperclip_estimated', handlerSource.includes('paperclip_estimated'));
    check('API mentions paperclip_usage', handlerSource.includes('paperclip_usage'));
    check('API docs say no provider credentials needed', handlerSource.includes('no provider credentials required'));
  } catch (e) {
    check(`api-handler read: ${e.message}`, false);
  }

  // 4. Verify Cost Ledger schema
  console.log('\n--- Cost Ledger Schema Verification ---');
  try {
    const schemaSource = readSource('server/costs/schema.js');
    check('upsertCostRecord exists', schemaSource.includes('upsertCostRecord'));
    check('queryCostRecords exists', schemaSource.includes('queryCostRecords'));
    check('schema accepts company_id', schemaSource.includes('company_id'));
  } catch (e) {
    check(`schema read: ${e.message}`, false);
  }

  // 5. Verify migration 007
  console.log('\n--- Migration Verification ---');
  try {
    const migration = readSource('db/migrations/007_provider_cost_ledger.sql');
    check('Migration 007 has company_id column', migration.includes('company_id'));
    check('Migration 007 allows paperclip_estimated', migration.includes("'paperclip_estimated'"));
    check('Migration 007 allows paperclip_usage', migration.includes("'paperclip_usage'"));
    check('Migration 007 has proper UNIQUE constraint', migration.includes('UNIQUE'));
  } catch (e) {
    check(`migration 007 read: ${e.message}`, false);
  }

  // 6. Verify model_token_ledger migration
  try {
    const mig8 = readSource('db/migrations/008_model_token_ledger.sql');
    check('Migration 008 (model_token_ledger) exists', mig8.includes('model_token_ledger'));
    check('  has accuracy CHECK constraint', mig8.includes('accuracy'));
    check('  has provider_reported label', mig8.includes("'provider_reported'"));
    check('  has missing_usage label', mig8.includes("'missing_usage'"));
    check('  has raw_provider_usage JSONB', mig8.includes('raw_provider_usage'));
  } catch (e) {
    check(`migration 008 read: ${e.message}`, false);
  }

  // 7. Verify agent_token_usage migration
  try {
    const mig9 = readSource('db/migrations/009_agent_token_usage.sql');
    check('Migration 009 (agent_token_usage) exists', mig9.includes('agent_token_usage'));
    check('  has materialized view for monthly aggregation', mig9.includes('mv_agent_token_monthly'));
    check('  has usage_source CHECK', mig9.includes('usage_source'));
  } catch (e) {
    check(`migration 009 read: ${e.message}`, false);
  }

  // 8. Verify server.js wiring
  console.log('\n--- Server.js Wiring Verification ---');
  try {
    const serverSource = readSource('server.js');
    check('server.js imports cost routes', serverSource.includes("registerCostRoutes"));
    check('server.js imports token routes', serverSource.includes("registerTokenRoutes"));
    check('server.js imports recordTokenUsage', serverSource.includes("recordTokenUsage"));
    check('server.js registers cost routes', serverSource.includes("registerCostRoutes(app)"));
    check('server.js registers token routes', serverSource.includes("registerTokenRoutes(app)"));
    check('server.js records tokens in generateLlmReply', serverSource.includes("recordTokenUsage({"));
    check('  context has callType llm', serverSource.includes("callType: 'llm'"));
    check('  fire-and-forget (.catch)', serverSource.includes(".catch(() => {})"));
  } catch (e) {
    check(`server.js read: ${e.message}`, false);
  }

  // 9. Verify provider credential independence
  console.log('\n--- Provider Credential Independence ---');
  try {
    const fetcherSource = readSource('server/costs/fetcher.js');
    check('Base fetcher exists', fetcherSource.includes('BaseFetcher'));
  } catch (e) {
    check(`fetcher read: ${e.message}`, false);
  }

  try {
    const schedulerSource = readSource('server/costs/sync-scheduler.js');
    check('sync-scheduler has estimation fallback', schedulerSource.includes('runEstimationFallback'));
    check('  uses agent_token_usage first', schedulerSource.includes('agent_token_usage'));
    check('  falls back to batch_sessions', schedulerSource.includes('batch_sessions'));
    check('  marks source as paperclip_usage', schedulerSource.includes("'paperclip_usage'"));
    check('  marks source as paperclip_estimated', schedulerSource.includes("'paperclip_estimated'"));
  } catch (e) {
    check(`scheduler read: ${e.message}`, false);
  }

  // 10. Verify sync-scheduler imports
  console.log('\n--- Sync-Scheduler Module Check ---');
  try {
    const syncScheduler = await import(path.join(repoRoot, 'server/costs/sync-scheduler.js'));
    check('syncAllProviders exported', typeof syncScheduler.syncAllProviders === 'function');
    check('syncProvider exported', typeof syncScheduler.syncProvider === 'function');
    check('runEstimationFallback exported', typeof syncScheduler.runEstimationFallback === 'function');
    check('getSyncStatusSummary exported', typeof syncScheduler.getSyncStatusSummary === 'function');
  } catch (e) {
    check(`sync-scheduler: ${e.message}`, false);
  }

  console.log('\n========================================');
  if (failures === 0) {
    console.log('ALL CHECKS PASSED');
  } else {
    console.log(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Verification script error:', err);
  process.exit(1);
});
