// server/tokens/local-agent-token-store.js
// JSON file-based agent_token_usage store for development/testing.
// Used as fallback when PostgreSQL is unavailable.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_STORE_PATH = path.resolve(__dirname, '../../data/agent-token-usage.json');

export class LocalAgentTokenStore {
  constructor(storePath = DEFAULT_STORE_PATH) {
    this.storePath = storePath;
    this.records = null;
  }

  _getRecords() {
    if (this.records === null) {
      try {
        if (fs.existsSync(this.storePath)) {
          const raw = fs.readFileSync(this.storePath, 'utf8');
          this.records = JSON.parse(raw);
          if (!Array.isArray(this.records)) this.records = [];
        } else {
          this.records = [];
        }
      } catch {
        this.records = [];
      }
    }
    return this.records;
  }

  _saveRecords() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify(this.records, null, 2));
  }

  _generateId() {
    return crypto.randomUUID();
  }

  async insertRecord(record) {
    const list = this._getRecords();
    const id = record.id || this._generateId();
    const r = {
      id,
      run_id: record.runId || record.run_id,
      agent_id: record.agentId || record.agent_id || null,
      issue_id: record.issueId || record.issue_id || null,
      provider: record.provider,
      model_id: record.modelId || record.model_id,
      tokens_input: record.tokensInput ?? record.tokens_input ?? 0,
      tokens_output: record.tokensOutput ?? record.tokens_output ?? 0,
      tokens_cache_read: record.tokensCacheRead ?? record.tokens_cache_read ?? 0,
      tokens_cache_write: record.tokensCacheWrite ?? record.tokens_cache_write ?? 0,
      tokens_reasoning: record.tokensReasoning ?? record.tokens_reasoning ?? 0,
      usage_source: record.usageSource || record.usage_source || 'agent_report',
      created_at: new Date().toISOString(),
    };
    list.push(r);
    this._saveRecords();
    return {
      id: r.id,
      runId: r.run_id,
      agentId: r.agent_id,
      issueId: r.issue_id,
      provider: r.provider,
      modelId: r.model_id,
      tokensInput: r.tokens_input,
      tokensOutput: r.tokens_output,
      tokensCacheRead: r.tokens_cache_read,
      tokensCacheWrite: r.tokens_cache_write,
      tokensReasoning: r.tokens_reasoning,
      usageSource: r.usage_source,
      createdAt: r.created_at,
    };
  }

  async queryRecords(opts = {}) {
    const list = this._getRecords();
    let filtered = list;

    if (opts.periodStart) {
      const start = new Date(opts.periodStart).getTime();
      filtered = filtered.filter((r) => new Date(r.created_at).getTime() >= start);
    }
    if (opts.periodEnd) {
      const end = new Date(opts.periodEnd).getTime();
      filtered = filtered.filter((r) => new Date(r.created_at).getTime() <= end);
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

    filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    if (opts.offset) {
      filtered = filtered.slice(parseInt(opts.offset, 10));
    }
    if (opts.limit) {
      filtered = filtered.slice(0, parseInt(opts.limit, 10));
    }

    return filtered.map((r) => ({
      id: r.id,
      runId: r.run_id,
      agentId: r.agent_id,
      issueId: r.issue_id,
      provider: r.provider,
      modelId: r.model_id,
      tokensInput: Number(r.tokens_input),
      tokensOutput: Number(r.tokens_output),
      tokensCacheRead: Number(r.tokens_cache_read || 0),
      tokensCacheWrite: Number(r.tokens_cache_write || 0),
      tokensReasoning: Number(r.tokens_reasoning || 0),
      usageSource: r.usage_source,
      createdAt: r.created_at,
    }));
  }

  async getAggregatedUsage(opts = {}) {
    const list = this._getRecords();
    let filtered = list;

    if (opts.periodStart) {
      const start = new Date(opts.periodStart).getTime();
      filtered = filtered.filter((r) => new Date(r.created_at).getTime() >= start);
    }
    if (opts.periodEnd) {
      const end = new Date(opts.periodEnd).getTime();
      filtered = filtered.filter((r) => new Date(r.created_at).getTime() <= end);
    }
    if (opts.provider) {
      filtered = filtered.filter((r) => r.provider === opts.provider);
    }
    if (opts.modelId) {
      filtered = filtered.filter((r) => r.model_id === opts.modelId);
    }

    const byModel = new Map();
    for (const r of filtered) {
      const key = `${r.provider}:${r.model_id}`;
      if (!byModel.has(key)) {
        byModel.set(key, { provider: r.provider, modelId: r.model_id, callCount: 0, tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0 });
      }
      const m = byModel.get(key);
      m.callCount++;
      m.tokensInput += Number(r.tokens_input || 0);
      m.tokensOutput += Number(r.tokens_output || 0);
      m.tokensCacheRead += Number(r.tokens_cache_read || 0);
      m.tokensCacheWrite += Number(r.tokens_cache_write || 0);
      m.tokensReasoning += Number(r.tokens_reasoning || 0);
    }

    return Array.from(byModel.values());
  }

  async getTotals(opts = {}) {
    const aggregated = await this.getAggregatedUsage(opts);
    return aggregated.reduce(
      (totals, m) => {
        totals.callCount += m.callCount;
        totals.tokensInput += m.tokensInput;
        totals.tokensOutput += m.tokensOutput;
        totals.tokensCacheRead += m.tokensCacheRead;
        totals.tokensCacheWrite += m.tokensCacheWrite;
        totals.tokensReasoning += m.tokensReasoning;
        return totals;
      },
      { callCount: 0, tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0 }
    );
  }
}
