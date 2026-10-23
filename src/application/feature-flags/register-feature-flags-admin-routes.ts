import express from 'express';
import * as core from 'express-serve-static-core';

import type { FeatureFlags } from '../../core/config/feature-flags';
import type { ILogger } from '../../core/decorators/ILogger';
import type { AuthenticatedRequest } from '../middleware/auth';
import { validateBody, type ValidatedRequest } from '../middleware/validation.middleware';
import {
  BulkUpdateFeatureFlagsRequestSchema,
  UpdateFeatureFlagsRequestSchema,
} from '../validators/api-schemas';
import { FeatureFlagsService } from '../services/FeatureFlagsService';

type ExpressRequest = core.Request;
type ExpressResponse = core.Response;

export type RegisterFeatureFlagsAdminRoutesOptions = {
  app: express.Application;
  authMw: core.RequestHandler;
  featureFlagsAdminMw: core.RequestHandler;
  featureFlagsService: FeatureFlagsService;
  logger?: ILogger;
};

export function registerFeatureFlagsAdminRoutes(
  options: RegisterFeatureFlagsAdminRoutesOptions,
): void {
  const {
    app,
    authMw,
    featureFlagsAdminMw,
    featureFlagsService,
    logger,
  } = options;

  app.get('/api/admin/feature-flags', authMw, featureFlagsAdminMw, async (_req: ExpressRequest, res: ExpressResponse) => {
    try {
      const flags = await featureFlagsService.getAllFlagsAsync();
      res.json({ flags });
    } catch (error) {
      logger?.error('Failed to get feature flags', { error });
      res.status(500).json({ error: 'Failed to get feature flags' });
    }
  });

  app.put('/api/admin/feature-flags', authMw, featureFlagsAdminMw, validateBody(UpdateFeatureFlagsRequestSchema), async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      const updates = (req as ValidatedRequest<Partial<FeatureFlags>>).validatedBody;
      await featureFlagsService.updateFlags(updates);
      const flags = await featureFlagsService.getAllFlagsAsync();

      logger?.info?.('Feature flags updated via API', {
        userId: (req as unknown as AuthenticatedRequest).user?.id,
        updates,
      });

      res.json({ flags });
    } catch (error) {
      logger?.error('Failed to update feature flags', { error });
      res.status(500).json({ error: 'Failed to update feature flags' });
    }
  });

  app.post('/api/admin/feature-flags/bulk', authMw, featureFlagsAdminMw, validateBody(BulkUpdateFeatureFlagsRequestSchema), async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      const { updates } = (req as ValidatedRequest<{ updates: Record<string, boolean> }>).validatedBody;

      const result = await featureFlagsService.bulkUpdateFlags(updates);

      logger?.info?.('Feature flags bulk updated via API', {
        userId: (req as unknown as AuthenticatedRequest).user?.id,
        count: Object.keys(updates).length,
      });

      res.json({
        success: true,
        applied: result.applied,
        failed: result.failed,
      });
    } catch (error) {
      logger?.error('Failed to bulk update feature flags', { error });
      res.status(500).json({ error: 'Failed to bulk update feature flags' });
    }
  });
}