// server/tokens/index.js — Token Ledger route registration
// Exports registerTokenRoutes(app) which registers all token endpoints.

import { registerIngestEndpoint } from './ingest.js';
import { registerQueryEndpoints } from './queries.js';
import { registerReportEndpoint } from './report-formatter.js';

/**
 * Register all Token Ledger routes on the Express app.
 * @param {import('express').Express} app
 */
export function registerTokenRoutes(app) {
  registerIngestEndpoint(app);
  registerQueryEndpoints(app);
  registerReportEndpoint(app);
  console.log('[tokens] Token Ledger routes registered');
}
