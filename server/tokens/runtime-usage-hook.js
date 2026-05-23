// server/tokens/runtime-usage-hook.js
// Runtime usage hook: captures model-call usage from pi-ai AssistantMessage
// and POSTs to the Token Ledger ingest API.
//
// This module is designed to be imported by any runtime (Paperclip, pi agent,
// test harness) that makes model calls via @mariozechner/pi-ai providers.
// It maps the pi-ai Usage/AssistantMessage structure to the Token Ledger
// ingest endpoint format and fires a non-blocking HTTP POST.
//
// When the Token Ledger ingest receives the record, it:
// 1. Stores per-call data in model_token_ledger
// 2. Upserts aggregated monthly counts to provider_cost_ledger (Cost Ledger)
//    with source='paperclip_estimated' — this makes runtime token usage
//    visible through the Cost Ledger API (GET /costs/models)
//
// Usage:
//   import { recordTokenUsage } from './server/tokens/runtime-usage-hook.js';
//
//   // From Paperclip runtime agent loop:
//   recordTokenUsage({
//     assistantMessage: lastAssistantMessage,  // pi-ai AssistantMessage
//     context: {
//       companyId: '...',
//       tokenLedgerBaseUrl: process.env.TOKEN_LEDGER_BASE_URL,
//       runId: '...',
//       agentId: '...',
//       issueId: '...',
//       sessionId: '...',
//       callType: 'llm',
//     },
//   }).catch(() => {});  // Never fail the run
//
//   // Or with explicit usage data (no AssistantMessage):
//   recordTokenUsage({
//     provider: 'anthropic',
//     modelId: 'claude-sonnet-4-6',
//     api: 'anthropic-messages',
//     usage: { input: 2000, output: 800, cacheRead: 500, cacheWrite: 200 },
//     context: { companyId: 'test', runId: 'run-1' },
//   }).catch(() => {});

/**
 * @typedef {Object} RuntimeUsageContext
 * @property {string} [companyId] - Paperclip/Mellow company ID (default: 'runtime')
 * @property {string} [tokenLedgerBaseUrl] - Base URL of the Token Ledger server (default: TOKEN_LEDGER_BASE_URL env or http://localhost:3210)
 * @property {string|null} [runId] - Paperclip run ID
 * @property {string|null} [agentId] - Agent ID making the call
 * @property {string|null} [issueId] - Issue/task ID being worked on
 * @property {string|null} [sessionId] - Session ID
 * @property {string} [callType] - Call type: 'llm' (default), 'embedding', 'image', 'audio'
 * @property {number} [timeoutMs] - HTTP request timeout in ms (default: 5000)
 */

/**
 * Record a model-call token usage by POSTing to the Token Ledger ingest API.
 *
 * Accepts either:
 * 1. `assistantMessage` — a pi-ai AssistantMessage with full usage/provider/model data
 * 2. Explicit `provider`, `modelId`, `usage` fields (for non-pi-ai runtimes)
 *
 * The POST is fire-and-forget: the returned promise rejects on failure but the
 * caller should never await it in a hot path — use `.catch(() => {})` to swallow.
 *
 * @param {object} opts
 * @param {object} [opts.assistantMessage] - pi-ai AssistantMessage object
 * @param {string} [opts.provider] - Provider name (used when assistantMessage not given)
 * @param {string} [opts.modelId] - Model ID (used when assistantMessage not given)
 * @param {string} [opts.api] - API name (used when assistantMessage not given)
 * @param {object} [opts.usage] - { input, output, cacheRead, cacheWrite, totalTokens } (used when assistantMessage not given)
 * @param {object|null} [opts.rawUsage] - Raw provider usage object (preserved as JSONB)
 * @param {string} [opts.accuracy] - 'provider_reported' | 'runtime_estimated' | 'missing_usage'
 * @param {RuntimeUsageContext} [opts.context] - Run/agent/issue/session context
 * @returns {Promise<object>} The created token ledger record
 */
export async function recordTokenUsage(opts = {}) {
  const ctx = opts.context || {};

  // Determine provider, model, and usage data from assistant message or explicit params
  let provider, modelId, api, usage, rawUsage, accuracy, calledAt;

  if (opts.assistantMessage) {
    const msg = opts.assistantMessage;
    provider = msg.provider || 'unknown';
    modelId = msg.model || msg.responseModel || 'unknown';
    api = msg.api || 'unknown';
    rawUsage = opts.rawUsage || null;
    calledAt = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();

    if (msg.usage) {
      usage = msg.usage;
      accuracy = opts.accuracy || (usage.totalTokens > 0 ? 'provider_reported' : 'missing_usage');
    } else {
      accuracy = opts.accuracy || 'missing_usage';
    }
  } else {
    // Explicit fields
    provider = (opts.provider || '').trim().toLowerCase() || 'unknown';
    modelId = opts.modelId || 'unknown';
    api = opts.api || 'unknown';
    rawUsage = opts.rawUsage || null;
    usage = opts.usage || null;
    accuracy = opts.accuracy || (usage ? 'provider_reported' : 'missing_usage');
    calledAt = opts.calledAt || new Date().toISOString();
  }

  // Build the ingest payload
  const payload = {
    provider,
    model_id: modelId,
    api,
    call_type: ctx.callType || 'llm',
    run_id: ctx.runId || null,
    agent_id: ctx.agentId || null,
    issue_id: ctx.issueId || null,
    session_id: ctx.sessionId || null,
    accuracy,
    called_at: calledAt,
    raw_usage: rawUsage,
  };

  // Map pi-ai Usage fields to the ingest schema
  if (usage) {
    payload.tokens_input = usage.input ?? 0;
    payload.tokens_output = usage.output ?? 0;
    payload.tokens_cache_read = usage.cacheRead ?? 0;
    payload.tokens_cache_write = usage.cacheWrite ?? 0;
    payload.tokens_total = usage.totalTokens ?? (payload.tokens_input + payload.tokens_output + payload.tokens_cache_read + payload.tokens_cache_write);

    // Map reasoning tokens if available
    // pi-ai Usage doesn't have reasoning_tokens directly — it's part of the raw provider usage
    // which gets normalized by the server-side provider-mapping
  }

  // Override with explicit fields if caller wants to supply more detail
  if (opts.tokens_reasoning != null) payload.tokens_reasoning = opts.tokens_reasoning;
  if (opts.tokens_prompt_cache_hit != null) payload.tokens_prompt_cache_hit = opts.tokens_prompt_cache_hit;
  if (opts.tokens_prompt_cache_miss != null) payload.tokens_prompt_cache_miss = opts.tokens_prompt_cache_miss;

  // Build the URL
  const baseUrl = ctx.tokenLedgerBaseUrl || process.env.TOKEN_LEDGER_BASE_URL || 'http://localhost:3210';
  const companyId = ctx.companyId || 'runtime';
  const url = `${baseUrl.replace(/\/+$/, '')}/api/companies/${encodeURIComponent(companyId)}/tokens/record`;

  // POST — fire with timeout, never throw on the hot path (caller must .catch())
  const controller = new AbortController();
  const timeoutMs = ctx.timeoutMs || 5000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Build headers with runtime API key if configured
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = ctx.runtimeApiKey || process.env.RUNTIME_API_KEY;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'no body');
      throw new Error(`Token ledger ingest returned ${response.status}: ${body}`);
    }

    const result = await response.json();
    return result.record || result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a context builder that binds common Paperclip runtime values
 * so individual recordTokenUsage calls only need the assistantMessage.
 *
 * @param {object} defaultCtx - Default context values
 * @param {string} [defaultCtx.companyId]
 * @param {string} [defaultCtx.tokenLedgerBaseUrl]
 * @param {string|null} [defaultCtx.runId]
 * @param {string|null} [defaultCtx.agentId]
 * @param {string|null} [defaultCtx.issueId]
 * @param {string|null} [defaultCtx.sessionId]
 * @param {string} [defaultCtx.callType]
 * @returns {function} A bound recordTokenUsage function
 */
export function createUsageRecorder(defaultCtx = {}) {
  /**
   * @param {object} opts
   * @param {object} [opts.assistantMessage]
   * @param {string} [opts.provider]
   * @param {string} [opts.modelId]
   * @param {object} [opts.usage]
   * @param {object} [opts.rawUsage]
   * @param {string} [opts.accuracy]
   * @param {object} [opts.context] - Overrides merged on top of defaultCtx
   * @returns {Promise<object>}
   */
  return (opts = {}) => {
    const mergedCtx = { ...defaultCtx, ...(opts.context || {}) };
    return recordTokenUsage({ ...opts, context: mergedCtx });
  };
}
