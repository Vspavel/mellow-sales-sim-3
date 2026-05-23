// server/tokens/local-store.js
// JSON file-based token record store for development/testing.
// Used as fallback when PostgreSQL is unavailable (STORAGE_DRIVER=file).
//
// Stores all records in a single JSON file: data/token-ledger.json
// Schema mirrors model_token_ledger table from migration 008.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_STORE_PATH = path.resolve(__dirname, '../../data/token-ledger.json');

let storePath = DEFAULT_STORE_PATH;
let records = null;

function getRecords() {
  if (records === null) {
    try {
      if (fs.existsSync(storePath)) {
        const raw = fs.readFileSync(storePath, 'utf8');
        records = JSON.parse(raw);
        if (!Array.isArray(records)) records = [];
      } else {
        records = [];
      }
    } catch {
      records = [];
    }
  }
  return records;
}

function saveRecords() {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(records, null, 2));
}

function generateId() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function toRecord(r) {
  return {
    id: r.id,
    companyId: r.company_id || null,
    runId: r.run_id || null,
    agentId: r.agent_id || null,
    issueId: r.issue_id || null,
    sessionId: r.session_id || null,
    provider: r.provider,
    modelId: r.model_id,
    api: r.api || 'unknown',
    callType: r.call_type || 'llm',
    tokensInput: Number(r.tokens_input || 0),
    tokensOutput: Number(r.tokens_output || 0),
    tokensCacheRead: Number(r.tokens_cache_read || 0),
    tokensCacheWrite: Number(r.tokens_cache_write || 0),
    tokensTotal: Number(r.tokens_total || 0),
    tokensReasoning: r.tokens_reasoning != null ? Number(r.tokens_reasoning) : null,
    tokensPromptCacheHit: r.tokens_prompt_cache_hit != null ? Number(r.tokens_prompt_cache_hit) : null,
    tokensPromptCacheMiss: r.tokens_prompt_cache_miss != null ? Number(r.tokens_prompt_cache_miss) : null,
    tokensAudioInput: r.tokens_audio_input != null ? Number(r.tokens_audio_input) : null,
    tokensAudioOutput: r.tokens_audio_output != null ? Number(r.tokens_audio_output) : null,
    rawProviderUsage: r.raw_provider_usage || null,
    accuracy: r.accuracy || 'provider_reported',
    costUsdCents: r.cost_usd_cents != null ? Number(r.cost_usd_cents) : null,
    calledAt: r.called_at || now(),
    recordedAt: r.recorded_at || now(),
    updatedAt: r.updated_at || now(),
  };
}

/**
 * Override the default store path (useful for tests).
 * @param {string} p
 */
export function setStorePath(p) {
  storePath = path.resolve(p);
  records = null; // Force reload on next access
}

/**
 * Clear all records (useful for tests/reset).
 */
export function clearStore() {
  records = [];
  if (fs.existsSync(storePath)) {
    fs.unlinkSync(storePath);
  }
}

export async function insertTokenRecordLocal(record) {
  const list = getRecords();
  const id = record.id || record.id || generateId();
  const calledAt = record.calledAt || record.called_at || now();
  const r = {
    id,
    company_id: record.companyId || record.company_id || null,
    run_id: record.runId || record.run_id || null,
    agent_id: record.agentId || record.agent_id || null,
    issue_id: record.issueId || record.issue_id || null,
    session_id: record.sessionId || record.session_id || null,
    provider: record.provider,
    model_id: record.modelId || record.model_id,
    api: record.api || 'unknown',
    call_type: record.callType || record.call_type || 'llm',
    tokens_input: record.tokensInput ?? record.tokens_input ?? 0,
    tokens_output: record.tokensOutput ?? record.tokens_output ?? 0,
    tokens_cache_read: record.tokensCacheRead ?? record.tokens_cache_read ?? 0,
    tokens_cache_write: record.tokensCacheWrite ?? record.tokens_cache_write ?? 0,
    tokens_total: record.tokensTotal ?? record.tokens_total ?? 0,
    tokens_reasoning: record.tokensReasoning ?? record.tokens_reasoning ?? null,
    tokens_prompt_cache_hit: record.tokensPromptCacheHit ?? record.tokens_prompt_cache_hit ?? null,
    tokens_prompt_cache_miss: record.tokensPromptCacheMiss ?? record.tokens_prompt_cache_miss ?? null,
    tokens_audio_input: record.tokensAudioInput ?? record.tokens_audio_input ?? null,
    tokens_audio_output: record.tokensAudioOutput ?? record.tokens_audio_output ?? null,
    raw_provider_usage: record.rawProviderUsage || record.raw_provider_usage || null,
    accuracy: record.accuracy || 'provider_reported',
    cost_usd_cents: record.costUsdCents ?? record.cost_usd_cents ?? null,
    called_at: typeof calledAt === 'string' ? calledAt : new Date(calledAt).toISOString(),
    recorded_at: now(),
    updated_at: now(),
  };
  list.push(r);
  saveRecords();
  return toRecord(r);
}

export async function queryTokenRecordsLocal(opts = {}) {
  const list = getRecords();
  let filtered = list;

  if (opts.companyId) {
    filtered = filtered.filter((r) => r.company_id === opts.companyId);
  }
  if (opts.periodStart) {
    const start = new Date(opts.periodStart).getTime();
    filtered = filtered.filter((r) => new Date(r.called_at).getTime() >= start);
  }
  if (opts.periodEnd) {
    const end = new Date(opts.periodEnd).getTime();
    filtered = filtered.filter((r) => new Date(r.called_at).getTime() <= end);
  }
  if (opts.provider) {
    filtered = filtered.filter((r) => r.provider === opts.provider);
  }
  if (opts.modelId) {
    filtered = filtered.filter((r) => r.model_id === opts.modelId);
  }
  if (opts.runId) {
    filtered = filtered.filter((r) => r.run_id === opts.runId);
  }
  if (opts.agentId) {
    filtered = filtered.filter((r) => r.agent_id === opts.agentId);
  }
  if (opts.issueId) {
    filtered = filtered.filter((r) => r.issue_id === opts.issueId);
  }
  if (opts.accuracy) {
    filtered = filtered.filter((r) => r.accuracy === opts.accuracy);
  }

  // Sort by called_at descending
  filtered.sort((a, b) => new Date(b.called_at).getTime() - new Date(a.called_at).getTime());

  if (opts.offset) {
    filtered = filtered.slice(parseInt(opts.offset, 10));
  }
  if (opts.limit) {
    filtered = filtered.slice(0, parseInt(opts.limit, 10));
  }

  return filtered.map(toRecord);
}

export async function getTokenSummaryLocal(opts = {}) {
  const list = getRecords();
  let filtered = list;

  if (opts.companyId) {
    filtered = filtered.filter((r) => r.company_id === opts.companyId);
  }
  if (opts.periodStart) {
    const start = new Date(opts.periodStart).getTime();
    filtered = filtered.filter((r) => new Date(r.called_at).getTime() >= start);
  }
  if (opts.periodEnd) {
    const end = new Date(opts.periodEnd).getTime();
    filtered = filtered.filter((r) => new Date(r.called_at).getTime() <= end);
  }
  if (opts.provider) {
    filtered = filtered.filter((r) => r.provider === opts.provider);
  }
  if (opts.modelId) {
    filtered = filtered.filter((r) => r.model_id === opts.modelId);
  }

  // Per-model aggregation
  const modelMap = new Map();
  const accuracyMap = new Map();
  let grandTotalCalls = 0;
  let grandInput = 0;
  let grandOutput = 0;
  let grandCacheRead = 0;
  let grandCacheWrite = 0;
  let grandTotal = 0;
  let grandReasoning = 0;

  for (const r of filtered) {
    const key = `${r.provider}:${r.model_id}`;
    if (!modelMap.has(key)) {
      modelMap.set(key, {
        provider: r.provider,
        model_id: r.model_id,
        tokens_input: 0,
        tokens_output: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        tokens_total: 0,
        tokens_reasoning: 0,
        tokens_prompt_cache_hit: 0,
        tokens_prompt_cache_miss: 0,
        call_count: 0,
      });
    }
    const m = modelMap.get(key);
    const ti = Number(r.tokens_input || 0);
    const to = Number(r.tokens_output || 0);
    const tcr = Number(r.tokens_cache_read || 0);
    const tcw = Number(r.tokens_cache_write || 0);
    const tt = Number(r.tokens_total || 0);
    const tr = Number(r.tokens_reasoning || 0);
    const tph = Number(r.tokens_prompt_cache_hit || 0);
    const tpm = Number(r.tokens_prompt_cache_miss || 0);
    m.tokens_input += ti;
    m.tokens_output += to;
    m.tokens_cache_read += tcr;
    m.tokens_cache_write += tcw;
    m.tokens_total += tt;
    m.tokens_reasoning += tr;
    m.tokens_prompt_cache_hit += tph;
    m.tokens_prompt_cache_miss += tpm;
    m.call_count++;

    grandTotalCalls++;
    grandInput += ti;
    grandOutput += to;
    grandCacheRead += tcr;
    grandCacheWrite += tcw;
    grandTotal += tt;
    grandReasoning += tr;

    const acc = r.accuracy || 'unknown';
    if (!accuracyMap.has(acc)) {
      accuracyMap.set(acc, { count: 0, tokens_total: 0 });
    }
    const a = accuracyMap.get(acc);
    a.count++;
    a.tokens_total += tt;
  }

  const models = Array.from(modelMap.values()).map((m) => ({
    provider: m.provider,
    modelId: m.model_id,
    tokensInput: m.tokens_input,
    tokensOutput: m.tokens_output,
    tokensCacheRead: m.tokens_cache_read,
    tokensCacheWrite: m.tokens_cache_write,
    tokensTotal: m.tokens_total,
    tokensReasoning: m.tokens_reasoning || null,
    tokensPromptCacheHit: m.tokens_prompt_cache_hit || null,
    tokensPromptCacheMiss: m.tokens_prompt_cache_miss || null,
    callCount: m.call_count,
  }));

  const accuracyBreakdown = Array.from(accuracyMap.entries()).map(([accuracy, data]) => ({
    accuracy,
    count: data.count,
    tokensTotal: data.tokens_total,
  }));

  return {
    totalCalls: grandTotalCalls,
    tokensInput: grandInput,
    tokensOutput: grandOutput,
    tokensCacheRead: grandCacheRead,
    tokensCacheWrite: grandCacheWrite,
    tokensTotal: grandTotal,
    tokensReasoning: grandReasoning || null,
    models,
    accuracyBreakdown,
  };
}
