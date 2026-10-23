/**
 * MAS Request Context - Creates MAS session context from request context.
 *
 * Layer: Application (MAS context coordination)
 */

import type { MasTraceId, MasRequest, MasSessionContext } from '../../agents/types/mas-types';
import {
  BrandedIds,
  type IRequestContext,
  type MasSessionId,
  type SessionId,
  type CorrelationId,
} from '../../../core/context/IRequestContext';

export function createMasSessionContextFromRequest(
  request: MasRequest,
  requestContext: IRequestContext,
): MasSessionContext {
  return {
    masSessionId: String(requestContext.getCorrelationId() ?? `mas-${Date.now()}`) as MasSessionId,
    correlationId: (String(requestContext.getCorrelationId() ?? `corr-${Date.now()}`)) as CorrelationId,
    masTraceId: requestContext.getCorrelationId() ? (String(requestContext.getCorrelationId()) as MasTraceId) : undefined,
    tenantId: request.session?.tenantId ?? requestContext.getTenantId(),
    userId: request.session?.userId ?? requestContext.getUserId(),
    requestContext,
    policyDecisions: { decisions: {} },
  };
}
