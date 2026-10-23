import express from 'express';
import * as core from 'express-serve-static-core';

import type { IRequestContext } from '../context/request-context';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IMasterAgent } from '../agents/core/master-agent';
import type { MasRequest } from '../agents/types/mas-types';
import { MasPolicyService } from '../agents/security/mas-policy-service';
import {
  createMasSessionContextFromRequest,
  setMasPolicyDecisions,
  updateMasContext,
} from '../agents/context/mas-request-context';

type ExpressRequest = core.Request;
type ExpressResponse = core.Response;

type RequestContextLike = {
  tenantId?: unknown;
  userId?: unknown;
  masSessionId?: unknown;
  correlationId?: unknown;
};

type RequestWithBody = ExpressRequest & {
  body?: unknown;
};

export type RegisterMasRoutesOptions = {
  app: express.Application;
  authMw: core.RequestHandler;
  rateLimitMw: core.RequestHandler;
  requestContext: IRequestContext;
  masterAgent: IMasterAgent;
  masPolicyService: MasPolicyService;
  logger?: ILogger;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRequestBodyRecord(req: ExpressRequest): Record<string, unknown> {
  const body = (req as RequestWithBody).body;
  return isRecord(body) ? body : {};
}

function sanitizeSession(
  session:
    | {
        masSessionId?: unknown;
        correlationId?: unknown;
        masTraceId?: unknown;
        tenantId?: unknown;
        userId?: unknown;
      }
    | undefined,
): Record<string, unknown> | undefined {
  if (!session) {
    return undefined;
  }

  return {
    masSessionId: session.masSessionId,
    correlationId: session.correlationId,
    masTraceId: session.masTraceId,
    tenantId: session.tenantId,
    userId: session.userId,
  };
}

export function registerMasRoutes(options: RegisterMasRoutesOptions): void {
  const {
    app,
    authMw,
    rateLimitMw,
    requestContext,
    masterAgent,
    masPolicyService,
    logger,
  } = options;

  app.post('/api/mas/execute', authMw, rateLimitMw, async (req: ExpressRequest, res: ExpressResponse) => {
    const body = getRequestBodyRecord(req);

    try {
      const scenario = body.scenario;

      if (typeof scenario !== 'string' || !scenario.trim()) {
        return res.status(400).json({
          error: {
            code: 'INVALID_MAS_REQUEST',
            message: 'Field "scenario" is required and must be a non-empty string',
          },
        });
      }

      const masRequest: MasRequest = {
        scenario,
        useCase: typeof body.useCase === 'string' ? body.useCase : undefined,
        payload: body.payload,
        strategy: body.strategy as MasRequest['strategy'],
        session: body.session as MasRequest['session'],
        metadata: body.metadata as MasRequest['metadata'],
      };

      const session = createMasSessionContextFromRequest(masRequest, requestContext);

      const preflightDecision = await masPolicyService.evaluatePreflight({
        request: masRequest,
        session,
        requestContext,
      });

      const existingDecisions = session.policyDecisions?.decisions ?? {};
      session.policyDecisions = {
        decisions: {
          ...existingDecisions,
          'mas.preflight': preflightDecision.rawDecision,
        },
      };

      if (preflightDecision.policyEvaluationId) {
        session.metadata = {
          ...(session.metadata ?? {}),
          lastPolicyEvaluationId: preflightDecision.policyEvaluationId,
        };
      }

      setMasPolicyDecisions(requestContext, session.policyDecisions);

      const normalizedSession = updateMasContext(session, requestContext);

      if (preflightDecision.status === 'deny') {
        return res.status(200).json({
          success: false,
          result: null,
          messages: [
            {
              role: 'system' as const,
              content: 'MAS preflight policy denied execution for this scenario',
            },
          ],
          diagnostics: {
            policy: {
              decision_status: preflightDecision.status,
              reasons: preflightDecision.reasons ?? [],
              audit_ref: preflightDecision.auditRef,
            },
          },
          session: sanitizeSession(normalizedSession),
        });
      }

      const masRequestWithSession: MasRequest = {
        ...masRequest,
        session: normalizedSession,
      };

      const masResponse = await masterAgent.executeMultiAgentTask(
        masRequestWithSession,
        requestContext,
      );

      return res.status(200).json({
        success: masResponse.success,
        result: masResponse.result,
        messages: masResponse.messages,
        diagnostics: masResponse.diagnostics,
        session: sanitizeSession(masResponse.session),
      });
    } catch (error) {
      let contextData: RequestContextLike | undefined;

      try {
        contextData = requestContext.getContext();
      } catch {
        contextData = undefined;
      }

      const scenarioValue = typeof body.scenario === 'string' ? body.scenario : undefined;
      const asError =
        error instanceof Error
          ? error
          : new Error(typeof error === 'string' ? error : 'MAS execution failed');

      logger?.error?.('[MAS] Execution error', {
        component: 'mas',
        event_name: 'mas.session.failed',
        correlation_id:
          typeof contextData?.correlationId === 'string' ? contextData.correlationId : undefined,
        mas_session_id:
          typeof contextData?.masSessionId === 'string' ? contextData.masSessionId : undefined,
        tenant_id: typeof contextData?.tenantId === 'string' ? contextData.tenantId : undefined,
        user_id: typeof contextData?.userId === 'string' ? contextData.userId : undefined,
        scenario: scenarioValue,
        error: {
          name: asError.name,
          message: asError.message,
          stack: asError.stack,
        },
      });

      return res.status(500).json({
        error: {
          code: 'MAS_EXECUTION_FAILED',
          message: asError.message ?? 'Unknown error',
        },
      });
    }
  });
}