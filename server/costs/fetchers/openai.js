// server/costs/fetchers/openai.js — OpenAI billing API fetcher
// Fetches cost/token data from OpenAI's usage API endpoint.

import { BaseFetcher } from '../fetcher.js';

export class OpenAIFetcher extends BaseFetcher {
  constructor() {
    super('openai', {});
  }

  requiresCredential() {
    return true;
  }

  _credentialsAvailable() {
    return !!process.env.OPENAI_API_KEY;
  }

  async fetch(periodStart, periodEnd) {
    // OpenAI billing API is not yet integrated for automated scraping
    // This will be implemented when OpenAI provides a billing/usage API.
    // For now, the estimation fallback handles OpenAI data.
    const err = new Error('OpenAI billing API not yet integrated — use estimation fallback');
    err.endpointNotAvailable = true;
    throw err;
  }
}
