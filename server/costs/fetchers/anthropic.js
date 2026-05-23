// server/costs/fetchers/anthropic.js — Anthropic billing API fetcher
// Fetches cost/token data from Anthropic's usage API endpoint.

import { BaseFetcher } from '../fetcher.js';

export class AnthropicFetcher extends BaseFetcher {
  constructor() {
    super('anthropic', {});
  }

  requiresCredential() {
    return true;
  }

  _credentialsAvailable() {
    return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_ADMIN_API_KEY);
  }

  async fetch(periodStart, periodEnd) {
    // Anthropic billing API is not yet integrated for automated scraping
    // This will be implemented when Anthropic provides a billing/usage API.
    // For now, the estimation fallback handles Anthropic data.
    const err = new Error('Anthropic billing API not yet integrated — use estimation fallback');
    err.endpointNotAvailable = true;
    throw err;
  }
}
