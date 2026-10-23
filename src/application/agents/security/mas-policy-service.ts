/**
 * MAS Policy Service - Application-layer adapter to PolicyEngine for MAS preflight checks.
 *
 * Layer: Application (MAS Runtime Core / security integration).
 *
 * Responsibilities (MAS-A4.2, see
 * [`07-MULTI_AGENT_SYSTEMS/MAS_POLICY_INTEGRATION_DESIGN.md`](07-MULTI_AGENT_SYSTEMS/MAS_POLICY_INTEGRATION_DESIGN.md:118)):
 * - Build a rich AccessRequest for MAS preflight from:
 *   - IRequestContext (transport / auth / tenant),
 *   - MasSessionContext (masSessionId / masTraceId / tenant / user),
 *   - MasRequest (scenario / useCase / payload metadata).
 * - Call PolicyEngine and map its PolicyDecision to a MAS-friendly result.
 * - Return a unified MasPreflightDecision that can be used by MAS entrypoints
 *   to:
 *   - decide whether to execute MasterAgent,
 *   - persist raw policy decision into MasSessionContext.policyDecisions,
 *   - surface high-level diagnostics back to clients.
 */

import type { IRequestContext } from '../../context/request-context';
import type {
  MasRequest,
  MasSessionContext,
  MasTaskConstraintBag,
  MasMetadataBag,
} from '../types/mas-types';
import type {
  AccessRequest,
  PolicyDecision,
  PolicyDecisionStatus,
  IPolicyEngine,
  PolicyContext,
} from '../../security/policy-engine';
import { incrementMasErrorsTotal } from '../observability/mas-metrics';

/**
 * High-level MAS view over a PolicyEngine decision for preflight.
 *
 * NOTE:
 * - `rawDecision` and `accessRequest` are included so that callers
 *   (e.g. MAS HTTP entrypoint) can store a stable snapshot into
 *   `MasSessionContext.policyDecisions` as an opaque JSON object,
 *   while still using the normalized fields (`status`, `constraints`,
 *   `reasons`, `auditRef`) for branching and diagnostics.
 */
export interface MasPreflightDecision {
  status: PolicyDecisionStatus;
  constraints?: MasTaskConstraintBag;
  reasons?: string[];
  auditRef?: string;
  /**
   * Optional identifier of the underlying PolicyEngine evaluation.
   * When present, this aligns with `policy.evaluate.*.policy_evaluation_id`
   * and can be used to stitch MAS events with the policy audit trail.
   */
  policyEvaluationId?: string;
  /**
   * Original PolicyEngine decision, preserved verbatim for storage
   * in MasSessionContext.policyDecisions under the `mas.preflight` key.
   */
  rawDecision: PolicyDecision;
  /**
   * AccessRequest that was evaluated by PolicyEngine. This is useful
   * for observability and future inline checks, but must NOT be exposed
   * directly over public HTTP APIs.
   */
  accessRequest: AccessRequest;
}

/**
 * Input for MAS preflight evaluation.
 */
export interface MasPreflightEvaluationInput {
  request: MasRequest;
  session: MasSessionContext;
  requestContext: IRequestContext;
}

/**
 * Application-layer service that encapsulates all MAS-specific logic
 * of constructing AccessRequest and interpreting PolicyEngine decisions.
 */
export class MasPolicyService {
  constructor(private readonly policyEngine: IPolicyEngine) {}

  /**
   * Evaluate MAS preflight policy decision for a given MAS request and session.
   *
   * This method is intentionally pure with respect to MasSessionContext:
   * - it does NOT mutate `session.policyDecisions`;
   * - the caller is responsible for persisting `rawDecision` into
   *   `MasSessionContext.policyDecisions.decisions['mas.preflight']`.
   */
  async evaluatePreflight(
    input: MasPreflightEvaluationInput,
  ): Promise<MasPreflightDecision> {
    const accessRequest = this.buildAccessRequest(input);

    try {
      const decision = await this.policyEngine.evaluateAccessRequest(accessRequest);

      return {
        status: decision.status,
        constraints: decision.constraints ?? undefined,
        reasons: decision.reasons,
        auditRef: decision.auditRef,
        policyEvaluationId: decision.evaluationId,
        rawDecision: decision,
        accessRequest,
      };
    } catch (error) {
      const scenario = input.request.scenario || 'unknown';
      const risk = this.classifyScenarioRisk(scenario);

      try {
        incrementMasErrorsTotal({
          component: 'other',
          errorType: 'policy_engine_unavailable',
        });
      } catch {
        // Metrics must never break MAS preflight.
      }

      const baseReasons = ['policy_engine_unavailable'];
      let status: PolicyDecisionStatus;
      let constraints: MasTaskConstraintBag | undefined;
      const reasons: string[] = [];

      if (risk === 'high') {
        status = 'deny';
        reasons.push(...baseReasons, 'high_risk_scenario');
      } else {
        status = 'allow_with_constraints';
        reasons.push(...baseReasons, 'fallback_safe_allow');
        constraints = {
          'mas.max_parallel_agents': 3,
          'mas.max_depth': 2,
        };
      }

      const syntheticDecision: PolicyDecision = {
        status,
        constraints: constraints ?? null,
        reasons,
        auditRef: undefined,
      };

      return {
        status: syntheticDecision.status,
        constraints: syntheticDecision.constraints ?? undefined,
        reasons: syntheticDecision.reasons,
        auditRef: syntheticDecision.auditRef,
        rawDecision: syntheticDecision,
        accessRequest,
      };
    }
  }
 
  /**
   * Classify MAS scenario into a coarse-grained risk level.
   *
   * This helper is intentionally simple and side-effect free; it is used only
   * for fallback behavior when PolicyEngine is unavailable. High-risk
   * scenarios (security/admin/governance-related) will be denied by default,
   * while all others are treated as low risk and may be allowed with
   * additional constraints.
   */
  // istanbul ignore next -- private fallback classifier; ?? and empty guard are defensive
  private classifyScenarioRisk(scenario: string): 'low' | 'high' {
    const normalized = (scenario ?? '').toLowerCase().trim();
    if (!normalized) return 'low';
 
    const highRiskKeywords = [
      'security',
      'auth',
      'admin',
      'privileged',
      'compliance',
      'governance',
      'policy',
    ];
 
    if (highRiskKeywords.some(keyword => normalized.includes(keyword))) {
      return 'high';
    }
 
    return 'low';
  }
 
  /**
   * Build AccessRequest according to the MAS preflight model
   * described in [`MAS_POLICY_INTEGRATION_DESIGN.md §3.2`](07-MULTI_AGENT_SYSTEMS/MAS_POLICY_INTEGRATION_DESIGN.md:118).
   */
  private buildAccessRequest(input: MasPreflightEvaluationInput): AccessRequest {
    const { request, session, requestContext } = input;

    const ctxData = requestContext.getContext();
    const tenantId = session.tenantId ?? requestContext.getTenantId();
    const userId = requestContext.getUserId();

    const scenario = request.scenario || 'unknown';
    const useCase = request.useCase;

    const actorType: 'user' | 'service' = userId ? 'user' : 'service';
    const actorId = userId ? String(userId) : 'service:mas';

    const actionBase = 'mas.execute';
    const actionScenario = `${actionBase}.scenario.${scenario}`;

    const resourceScenario = `mas.scenario.${scenario}`;

    const payloadShape = this.describePayloadShape(request.payload);

    const context: PolicyContext = {
      correlation_id: String(ctxData.correlationId),
      request_id: String(ctxData.requestId),
      masSessionId: String(session.masSessionId),
      masTraceId: session.masTraceId ? String(session.masTraceId) : undefined,
      tenant_id: tenantId ? String(tenantId) : undefined,
      user_id: userId ? String(userId) : undefined,
      scenario,
      useCase,
      payload_shape: payloadShape,
      http: {
        method: ctxData.method,
        path: ctxData.path,
        client_ip: ctxData.clientIp,
        user_agent: ctxData.userAgent,
      },
      mas: {
        session_id: String(session.masSessionId),
        trace_id: session.masTraceId ? String(session.masTraceId) : undefined,
      },
      action_base: actionBase,
    };

    return {
      actor: {
        type: actorType,
        id: actorId,
        tenantId,
      },
      action: actionScenario,
      resource: resourceScenario,
      tenantId,
      context,
    };
  }

  /**
   * Produce a lightweight textual descriptor of the MAS payload
   * without leaking raw content or PII.
   */
  private describePayloadShape(payload: unknown): string {
    if (payload === null || payload === undefined) {
      return 'none';
    }

    if (Array.isArray(payload)) {
      return 'array';
    }

    const t = typeof payload;

    if (t === 'string') {
      const length = (payload as string).length;
      return length === 0 ? 'string(empty)' : `string(len=${length})`;
    }

    if (t === 'object') {
      const keys = Object.keys(payload);
      if (keys.length === 0) {
        return 'object(empty)';
      }
      const preview = keys.slice(0, 5).join(',');
      const suffix = keys.length > 5 ? ',...' : '';
      return `object(${preview}${suffix})`;
    }

    return t;
  }
}
