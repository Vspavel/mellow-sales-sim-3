// server/costs/fetchers/deepseek.js — DeepSeek billing API fetcher
// Fetches cost/token data from DeepSeek's usage API endpoint.

import { BaseFetcher } from '../fetcher.js';

export class DeepSeekFetcher extends BaseFetcher {
  constructor() {
    super('deepseek', {});
  }

  requiresCredential() {
    return true;
  }

  _credentialsAvailable() {
    return !!process.env.DEEPSEEK_API_KEY;
  }

  async fetch(periodStart, periodEnd) {
    // DeepSeek billing API is not yet integrated for automated scraping
    // This will be implemented when DeepSeek provides a billing/usage API.
    // For now, the estimation fallback handles DeepSeek data.
    const err = new Error('DeepSeek billing API not yet integrated — use estimation fallback');
    err.endpointNotAvailable = true;
    throw err;
  }
}
