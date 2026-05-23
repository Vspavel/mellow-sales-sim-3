// server/tokens/provider-mapping.js
// Maps provider-specific raw usage fields to normalized token ledger fields.
// Each provider has its own shape of `raw_usage` from the API response.
// The result is merged with default values (all 0) so missing fields become 0.

const DEFAULT_NORMALIZED = {
  tokens_input: 0,
  tokens_output: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  tokens_total: 0,
  tokens_reasoning: null,
  tokens_prompt_cache_hit: null,
  tokens_prompt_cache_miss: null,
  tokens_audio_input: null,
  tokens_audio_output: null,
};

/**
 * Normalize raw provider usage into the common Token Ledger schema.
 * @param {string} provider — normalized provider name (e.g., 'anthropic', 'openai', 'deepseek', 'google', 'bedrock')
 * @param {object|null|undefined} rawUsage — raw usage object from the provider's API response
 * @returns {object} normalized fields object (can be spread into a DB insert)
 */
export function normalizeUsage(provider, rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return {
      ...DEFAULT_NORMALIZED,
      accuracy: rawUsage === null ? 'missing_usage' : 'runtime_estimated',
    };
  }

  const normalized = { ...DEFAULT_NORMALIZED };
  const p = (provider || '').toLowerCase().trim();

  switch (p) {
    case 'anthropic': {
      // Anthropic/Claude: input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
      const input = safeInt(rawUsage.input_tokens);
      const output = safeInt(rawUsage.output_tokens);
      normalized.tokens_input = input;
      normalized.tokens_output = output;
      normalized.tokens_cache_read = safeInt(rawUsage.cache_read_input_tokens);
      normalized.tokens_cache_write = safeInt(rawUsage.cache_creation_input_tokens);
      // Anthropic doesn't separate reasoning from output; leave tokens_reasoning as null
      break;
    }
    case 'openai': {
      // OpenAI: prompt_tokens (total), completion_tokens
      // prompt_tokens_details: { cached_tokens, cache_write_tokens }
      // completion_tokens_details: { reasoning_tokens }
      const prompt = safeInt(rawUsage.prompt_tokens);
      const cached = safeInt(rawUsage.prompt_tokens_details?.cached_tokens);
      const cacheWrite = safeInt(rawUsage.prompt_tokens_details?.cache_write_tokens);
      normalized.tokens_input = Math.max(0, prompt - cached - cacheWrite);
      normalized.tokens_output = safeInt(rawUsage.completion_tokens);
      normalized.tokens_cache_read = cached;
      normalized.tokens_cache_write = cacheWrite;
      normalized.tokens_reasoning = safeInt(rawUsage.completion_tokens_details?.reasoning_tokens) || null;
      break;
    }
    case 'deepseek': {
      // DeepSeek: prompt_tokens (total), completion_tokens
      // prompt_cache_hit_tokens, prompt_cache_miss_tokens, reasoning_tokens
      const prompt = safeInt(rawUsage.prompt_tokens);
      const cacheHit = safeInt(rawUsage.prompt_cache_hit_tokens);
      const cacheMiss = safeInt(rawUsage.prompt_cache_miss_tokens);
      normalized.tokens_input = Math.max(0, prompt - cacheHit - cacheMiss);
      normalized.tokens_output = safeInt(rawUsage.completion_tokens);
      normalized.tokens_cache_read = cacheHit;     // prompt_cache_hit_tokens → tokens_cache_read
      normalized.tokens_cache_write = 0;            // DeepSeek doesn't expose cache write tokens
      normalized.tokens_reasoning = safeInt(rawUsage.reasoning_tokens) || null;
      normalized.tokens_prompt_cache_hit = cacheHit;
      normalized.tokens_prompt_cache_miss = cacheMiss;
      break;
    }
    case 'google': {
      // Google/Gemini: prompt_token_count, candidates_token_count, cached_content_token_count
      normalized.tokens_input = safeInt(rawUsage.prompt_token_count);
      normalized.tokens_output = safeInt(rawUsage.candidates_token_count);
      normalized.tokens_cache_read = safeInt(rawUsage.cached_content_token_count);
      normalized.tokens_cache_write = 0;
      break;
    }
    case 'bedrock': {
      // AWS Bedrock: depends on underlying model; pass through raw_usage for now.
      // Common fields: inputTextTokenCount, outputTextTokenCount
      normalized.tokens_input = safeInt(rawUsage.inputTextTokenCount) || safeInt(rawUsage.input_tokens);
      normalized.tokens_output = safeInt(rawUsage.outputTextTokenCount) || safeInt(rawUsage.output_tokens);
      normalized.tokens_cache_read = safeInt(rawUsage.cache_read_input_tokens) || 0;
      normalized.tokens_cache_write = safeInt(rawUsage.cache_creation_input_tokens) || 0;
      break;
    }
    default: {
      // Unknown provider: try common field names as best-effort
      normalized.tokens_input = safeInt(rawUsage.input_tokens) || safeInt(rawUsage.prompt_tokens) || safeInt(rawUsage.prompt_token_count) || 0;
      normalized.tokens_output = safeInt(rawUsage.output_tokens) || safeInt(rawUsage.completion_tokens) || safeInt(rawUsage.candidates_token_count) || 0;
      normalized.tokens_cache_read = safeInt(rawUsage.cache_read_input_tokens) || safeInt(rawUsage.prompt_cache_hit_tokens) || safeInt(rawUsage.cached_content_token_count) || safeInt(rawUsage.prompt_tokens_details?.cached_tokens) || 0;
      normalized.tokens_cache_write = safeInt(rawUsage.cache_creation_input_tokens) || safeInt(rawUsage.prompt_tokens_details?.cache_write_tokens) || 0;
      normalized.tokens_reasoning = safeInt(rawUsage.reasoning_tokens) || safeInt(rawUsage.completion_tokens_details?.reasoning_tokens) || null;
      break;
    }
  }

  // Calculate total from components
  normalized.tokens_total =
    normalized.tokens_input +
    normalized.tokens_output +
    normalized.tokens_cache_read +
    normalized.tokens_cache_write;

  return normalized;
}

function safeInt(val) {
  if (val == null) return 0;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
