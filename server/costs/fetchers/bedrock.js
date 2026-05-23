// server/costs/fetchers/bedrock.js — AWS Bedrock billing API fetcher
// Fetches cost/token data from AWS Bedrock's usage API endpoint.

import { BaseFetcher } from '../fetcher.js';

export class BedrockFetcher extends BaseFetcher {
  constructor() {
    super('bedrock', {});
  }

  requiresCredential() {
    return true;
  }

  _credentialsAvailable() {
    return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  }

  async fetch(periodStart, periodEnd) {
    // Bedrock billing API is not yet integrated for automated scraping
    // This will be implemented when Bedrock provides a billing/usage API.
    // For now, the estimation fallback handles Bedrock data.
    const err = new Error('Bedrock billing API not yet integrated — use estimation fallback');
    err.endpointNotAvailable = true;
    throw err;
  }
}
