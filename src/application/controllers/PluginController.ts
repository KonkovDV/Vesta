import express from 'express';
import * as core from 'express-serve-static-core';
type Request = core.Request;
type Response = core.Response;
import { z } from 'zod';
import type { IUnifiedPluginRegistry } from '../plugins/unified-plugin-registry';
import { RequestContext } from '../context/request-context';
import type { ILogger } from '../../core/decorators/ILogger';

const PLUGIN_NAME_MAX_LENGTH = 128;
const PLUGIN_VERSION_MAX_LENGTH = 64;
const PLUGIN_PAYLOAD_MAX_JSON_LENGTH = 50_000;

const PluginExecuteRequestSchema = z.object({
  name: z
    .string()
    .transform((raw) => raw.trim())
    .pipe(z.string().min(1).max(PLUGIN_NAME_MAX_LENGTH)),
  version: z
    .string()
    .transform((raw) => raw.trim())
    .pipe(z.string().min(1).max(PLUGIN_VERSION_MAX_LENGTH))
    .optional(),
  payload: z
    .unknown()
    .refine(
      (value) => {
        if (value === undefined || value === null) {
          return true;
        }

        try {
          const serialized = JSON.stringify(value);
          return serialized.length <= PLUGIN_PAYLOAD_MAX_JSON_LENGTH;
        } catch {
          // Reject non-serializable payloads to avoid unexpected behavior.
          return false;
        }
      },
      {
        message: 'Payload too large or not serializable',
      },
    )
    .optional(),
});

type PluginExecuteRequest = z.infer<typeof PluginExecuteRequestSchema>;

export class PluginController {
  constructor(
    private readonly registry: IUnifiedPluginRegistry,
    private readonly logger?: ILogger,
  ) {}

  /**
   * POST /api/plugins/execute
   *
   * Minimal HTTP entrypoint for Unified Plugin Registry v1.
   * Body:
   * {
   *   "name": string,
   *   "version"?: string,
   *   "payload"?: unknown
   * }
   */
  async execute(req: Request, res: Response): Promise<void> {
    const parseResult = PluginExecuteRequestSchema.safeParse(req.body ?? {});

    if (!parseResult.success) {
      res.status(400).json({
        error: { message: 'Invalid plugin execute request' },
      });
      return;
    }

    const parsed: PluginExecuteRequest = parseResult.data;

    const route = {
      name: parsed.name,
      version: parsed.version,
    };

    const payload = parsed.payload;

    // RCTX-PLUGINS-HTTP-UPR: ensure RequestContext is initialized for this HTTP entrypoint.
    try {
      // Touch correlationId once to validate AsyncLocal wiring; value is not used directly here.
      const correlationId = RequestContext.getCorrelationId();
      void correlationId;
    } catch {
      if (this.logger) {
        const path =
          (req as { originalUrl?: string }).originalUrl ??
          (req as { url?: string }).url;
        this.logger.warn('rctx_not_initialized_for_plugins_execute', {
          layer: 'application',
          route: '/api/plugins/execute',
          method: req.method,
          path,
        });
      }
    }

    // RequestContext — текущий AsyncLocal request context (см. RequestContextMiddleware).
    const ctx = RequestContext;

    const result = await this.registry.call(
      route,
      payload,
      ctx,
    );

    res.status(200).json(result);
  }
}