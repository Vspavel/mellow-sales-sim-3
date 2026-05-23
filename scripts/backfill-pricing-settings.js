#!/usr/bin/env node
/**
 * backfill-pricing-settings.js
 *
 * CLI script to create default pricing settings for models in the token ledger
 * that don't already have a pricing setting.
 *
 * Usage:
 *   node scripts/backfill-pricing-settings.js <companyId>
 *
 * Example:
 *   node scripts/backfill-pricing-settings.js company-default
 */

import { query } from '../db/client.js';
import crypto from 'crypto';

function uuid() {
  return crypto.randomUUID();
}

async function backfill(companyId) {
  if (!companyId) {
    console.error('Usage: node scripts/backfill-pricing-settings.js <companyId>');
    process.exit(1);
  }

  console.log(`\n=== Backfill Pricing Settings ===`);
  console.log(`Company: ${companyId}\n`);

  // Find all distinct (provider, model_id) in token ledger without pricing settings
  const missingResult = await query(
    `SELECT DISTINCT mtl.provider, mtl.model_id
     FROM model_token_ledger mtl
     WHERE mtl.company_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM model_pricing_settings mps
         WHERE mps.company_id = mtl.company_id
           AND mps.provider = mtl.provider
           AND mps.model_id = mtl.model_id
       )
     ORDER BY mtl.provider, mtl.model_id`,
    [companyId]
  );

  const rows = missingResult.rows;
  console.log(`Found ${rows.length} model(s) without pricing settings:\n`);

  if (rows.length === 0) {
    console.log('All models already have pricing settings. Nothing to do.');
    return { created: 0 };
  }

  let created = 0;
  for (const row of rows) {
    const id = uuid();
    await query(
      `INSERT INTO model_pricing_settings
         (id, company_id, provider, model_id,
          cost_per_input_token, cost_per_output_token,
          cost_per_cache_read_token, cost_per_cache_write_token,
          is_default, label)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0, true, $5)`,
      [id, companyId, row.provider, row.model_id, `Auto-created via backfill script`]
    );
    console.log(`  Created: ${row.provider} / ${row.model_id}`);
    created++;
  }

  console.log(`\nDone. Created ${created} pricing setting(s).`);
  return { created };
}

// Run
const companyId = process.argv[2];
backfill(companyId)
  .then((result) => {
    console.log(`\nBackfill complete. ${result.created} setting(s) created.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
