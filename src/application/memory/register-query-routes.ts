import express from 'express';
import * as core from 'express-serve-static-core';

import type { IRequestContext } from '../context/request-context';
import { resolveScopedTenant } from '../middleware/auth';
import type { RagQueryInput } from '../../core/memory/rag-types';
import type { RagQueryService } from './rag-query.service';
import type { MasAdvancedRetrievalFacade } from '../agents/memory/mas-advanced-retrieval.facade';
import { MemorySearchController } from '../controllers/memorySearchController';
import { MasController } from '../controllers/masController';

type ExpressRequest = core.Request;
type ExpressResponse = core.Response;

type RequestWithBody = ExpressRequest & {
  body?: unknown;
};

type RequestContextLike = {
  tenantId?: unknown;
  userId?: unknown;
  sessionId?: unknown;
};

export type RegisterQueryRoutesOptions = {
  app: express.Application;
  authMw: core.RequestHandler;
  rateLimitMw: core.RequestHandler;
  requestContext: IRequestContext;
  ragQueryService: RagQueryService;
  memorySearchController: MemorySearchController;
  masAdvancedRetrievalFacade: MasAdvancedRetrievalFacade;
  masController: MasController;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRequestBodyRecord(req: ExpressRequest): Record<string, unknown> {
  const body = (req as RequestWithBody).body;
  return isRecord(body) ? body : {};
}

function contextTenantId(requestContext: IRequestContext): string | undefined {
  try {
    const ctx = requestContext.getContext() as RequestContextLike;
    return typeof ctx.tenantId === 'string' && ctx.tenantId.length > 0 ? ctx.tenantId : undefined;
  } catch {
    return undefined;
  }
}

export function registerQueryRoutes(options: RegisterQueryRoutesOptions): void {
  const {
    app,
    authMw,
    rateLimitMw,
    requestContext,
    ragQueryService,
    memorySearchController,
    masAdvancedRetrievalFacade,
    masController,
  } = options;

  app.post(
    '/bff/rag/query',
    authMw,
    rateLimitMw,
    async (req: ExpressRequest, res: ExpressResponse) => {
      const body = getRequestBodyRecord(req);
      const query = body.query;
      const topK = body.topK;
      const bodyUserId = body.userId;

      if (typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({
          error: {
            code: 'INVALID_RAG_REQUEST',
            message: 'Field "query" is required and must be a non-empty string',
          },
        });
      }

      let tenantId: string | undefined;
      let userId: string | undefined;
      let sessionId: string | undefined;

      try {
        const ctx = requestContext.getContext() as RequestContextLike;
        tenantId = typeof ctx.tenantId === 'string' ? ctx.tenantId : undefined;
        userId = typeof ctx.userId === 'string' ? ctx.userId : undefined;
        sessionId = typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined;
      } catch {
        // Best-effort: отсутствие RequestContext не должно ломать RAG endpoint.
      }

      if (!userId && typeof bodyUserId === 'string' && bodyUserId.trim()) {
        userId = bodyUserId.trim();
      }

      const ragInput: RagQueryInput = {
        tenantId: tenantId && tenantId.length > 0 ? tenantId : 'unknown',
        userId,
        sessionId,
        query,
        topK: typeof topK === 'number' && topK > 0 ? topK : undefined,
      };

      const items = await ragQueryService.query(ragInput);

      return res.json({ items });
    },
  );

  app.post(
    '/bff/memory/semantic-search',
    authMw,
    rateLimitMw,
    (req: ExpressRequest, res: ExpressResponse) =>
      memorySearchController.semanticSearch(req, res),
  );

  app.post(
    '/api/memory/advanced-retrieval',
    authMw,
    rateLimitMw,
    async (req: ExpressRequest, res: ExpressResponse) => {
      const body = getRequestBodyRecord(req) as {
        tenantId?: unknown;
        sessionId?: unknown;
        query?: unknown;
        topK?: unknown;
        namespace?: unknown;
        filters?: unknown;
      };

      const bodyTenantId =
        typeof body.tenantId === 'string' && body.tenantId.trim().length > 0
          ? body.tenantId.trim()
          : undefined;
      const scope = resolveScopedTenant(req, bodyTenantId, () => contextTenantId(requestContext));
      if (!scope.allowed) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'tenantId does not match the authenticated tenant',
          },
        });
      }
      const tenantId = scope.tenantId;
      const query =
        typeof body.query === 'string' && body.query.trim().length > 0
          ? body.query
          : undefined;

      if (!tenantId || !query) {
        return res.status(400).json({
          error: {
            code: 'INVALID_ADVANCED_RETRIEVAL_REQUEST',
            message:
              'A tenant and a non-empty "query" are required; the tenant comes from the API key, x-tenant-id or "tenantId"',
          },
        });
      }

      const sessionId =
        typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
          ? body.sessionId
          : undefined;

      const topK =
        typeof body.topK === 'number' && body.topK > 0 ? body.topK : undefined;

      const namespace =
        typeof body.namespace === 'string' && body.namespace.length > 0
          ? body.namespace
          : undefined;

      const filters =
        body.filters &&
        typeof body.filters === 'object' &&
        !Array.isArray(body.filters)
          ? (body.filters as Record<string, unknown>)
          : undefined;

      try {
        const result = await masAdvancedRetrievalFacade.executeForMas({
          tenantId,
          sessionId,
          query,
          topK,
          namespace,
          filters,
        });

        return res.status(200).json(result);
      } catch (error) {
        const message =
          error instanceof Error && typeof error.message === 'string'
            ? error.message
            : 'Advanced retrieval failed';

        return res.status(500).json({
          error: {
            code: 'ADVANCED_RETRIEVAL_FAILED',
            message,
          },
        });
      }
    },
  );

  app.post(
    '/bff/mas/generate-plan',
    authMw,
    rateLimitMw,
    (req: ExpressRequest, res: ExpressResponse) =>
      masController.generatePlan(req, res),
  );
}