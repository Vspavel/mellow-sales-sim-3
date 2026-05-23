/**
 * index.js — Model Pricing Settings route registration
 */

import settingsRouter from './settings.js';

/**
 * registerPricingRoutes(app)
 *
 * Mounts all /api/companies/:companyId/pricing/* routes onto the Express app.
 */
export function registerPricingRoutes(app) {
  app.use(settingsRouter);
}
