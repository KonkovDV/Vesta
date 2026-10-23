/**
 * PolicyEngine typed event payloads (Core layer).
 *
 * Canonical TypeScript contracts aligned with JSON Schema definitions for:
 * - `policy.evaluate.requested`
 * - `policy.evaluate.decision`
 *
 * JSON schemas: see
 * [`05-PLUGIN_SYSTEM/14-typed-events-registry.md`](05-PLUGIN_SYSTEM/14-typed-events-registry.md:2525).
 */

/**
 * Logical actor type for PolicyEngine events.
 *
 * Must stay compatible with `AccessRequest.actor.type` from
 * [`src/application/security/policy-engine.ts`](src/application/security/policy-engine.ts:26)
 * and JSON Schema enums for `actor_type` in `policy.evaluate.*`.
 */
export type PolicyActorType = 'user' | 'service' | string;

/**
 * Status of a PolicyEngine decision as used in typed events.
 *
 * Mirrors `PolicyDecisionStatus` from
 * [`src/application/security/policy-engine.ts`](src/application/security/policy-engine.ts:64)
 * and JSON Schema `status` enum for `policy.evaluate.decision`.
 */
export type PolicyDecisionStatus = 'allow' | 'allow_with_constraints' | 'deny';

/**
 * Payload for `policy.evaluate.requested`.
 *
 * Extends Record<string, unknown> to be compatible with
 * `EventFactory.createBaseEvent<TPayload extends Record<string, unknown>>()`.
 */
export interface PolicyEvaluateRequestedEventPayload
  extends Record<string, unknown> {
  /** Stable identifier of the policy evaluation, shared across the pair of events. */
  policy_evaluation_id: string;
  /** Tenant identifier (multi‑tenancy boundary). */
  tenant_id: string;
  /** Logical actor type (user / service). */
  actor_type: PolicyActorType;
  /** Logical actor identifier (user or technical service). */
  actor_id: string;
  /** Logical action, e.g. `mas.execute.scenario.foo` or `memory.operation.add_message`. */
  action: string;
  /** Logical resource, e.g. `mas.scenario.foo` or `memory.session`. */
  resource: string;
  /** Normalized source of the request: `mas`, `memory`, `plugin`, `bff`, `internal`, etc. */
  source: string;
  /** Optional sensitivity classification of the operation/data. */
  sensitivity?: string;
  /**
   * Legacy policy tags attached to the request.
   *
   * NOTE:
   * - Present in runtime payloads as of MEM‑NEXT.1.
   * - Not part of the minimal JSON Schema, but allowed via `additionalProperties`.
   * - For new producers prefer `requested_capabilities` while keeping this
   *   field for backwards compatibility.
   */
  policy_tags?: string[];
  /**
   * Optional explicit capability list derived from the request/context.
   *
   * In the current runtime this may mirror `policy_tags` for compatibility
   * with the JSON Schema contract.
   */
  requested_capabilities?: string[];
  /** ISO 8601 timestamp when evaluation was requested. */
  timestamp: string;
  /** Correlation id used for end‑to‑end tracing (RCTX‑POLICY contract). */
  correlation_id: string;
}

/**
 * Payload for `policy.evaluate.decision`.
 *
 * Extends Record<string, unknown> to be compatible with
 * `EventFactory.createBaseEvent<TPayload extends Record<string, unknown>>()`.
 */
export interface PolicyEvaluateDecisionEventPayload
  extends Record<string, unknown> {
  /** Stable identifier of the policy evaluation, shared across the pair of events. */
  policy_evaluation_id: string;
  /** Tenant identifier (multi‑tenancy boundary). */
  tenant_id: string;
  /** Logical actor type (user / service). */
  actor_type: PolicyActorType;
  /** Logical actor identifier (user or technical service). */
  actor_id: string;
  /** Logical action that was evaluated. */
  action: string;
  /** Logical resource that was evaluated. */
  resource: string;
  /** Normalized source of the request: `mas`, `memory`, `plugin`, `bff`, `internal`, etc. */
  source: string;
  /** Final status of the decision. */
  status: PolicyDecisionStatus;
  /** Machine‑readable reasons behind the decision (non‑empty). */
  reasons: string[];
  /**
   * Optional constraint bag describing budget/tool/agent limits etc.
   * Mirrors `PolicyDecision.constraints` but kept structurally opaque for
   * typed‑events consumers.
   */
  constraints?: Record<string, unknown>;
  /** Optional audit reference that links the decision to immutable audit storage. */
  audit_ref?: string;
  /** Optional latency of the evaluation in milliseconds. */
  decision_latency_ms?: number;
  /** ISO 8601 timestamp when the decision was recorded. */
  timestamp: string;
  /** Correlation id used for end‑to‑end tracing (RCTX‑POLICY contract). */
  correlation_id: string;
}

