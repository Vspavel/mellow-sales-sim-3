// server/costs/fetcher.js — Base fetcher class for provider billing API sync.
// Each provider (Anthropic, OpenAI, DeepSeek, Bedrock) extends this class
// to fetch cost/token data from their billing API.

export class BaseFetcher {
  constructor(providerName, config = {}) {
    this.providerName = providerName;
    this.config = config;
  }

  /**
   * Whether this fetcher requires provider credentials to operate.
   * Override in subclasses to return false for providers that don't
   * need credentials (e.g., free estimation-only paths).
   */
  requiresCredential() {
    return true;
  }

  /**
   * Check if credentials are available for this provider.
   * Override in subclasses with provider-specific env var checks.
   */
  _credentialsAvailable() {
    return false;
  }

  /**
   * Fetch cost records from the provider's billing API.
   * @param {Date} periodStart - Start of the period
   * @param {Date} periodEnd - End of the period
   * @returns {Promise<Array>} Array of provider cost record-like objects
   */
  async fetch(periodStart, periodEnd) {
    throw new Error('fetch() must be implemented by subclass');
  }
}
