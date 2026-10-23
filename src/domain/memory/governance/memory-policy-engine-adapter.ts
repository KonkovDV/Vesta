/**
 * Memory PolicyEngine adapter port (Memory layer).
 *
 * Layer: Domain
 *
 * This file defines the adapter interface used by Memory Governance to
 * delegate to the global PolicyEngine (Infrastructure layer).
 *
 * For MEM-NEXT.1 MVP we ship a stub implementation that always returns
 * "allow". Real integration will be provided in MEM-NEXT.* tasks.
 */

import type { MemoryGovernanceRequest } from './memory-governance.types';

export type UpstreamPolicyDecisionStatus = 'allow' | 'deny' | 'allow_with_constraints';

export interface UpstreamPolicyConstraints {
  /**
   * Optional upper bound for effective context tokens.
   * Governance maps this to MemoryGovernanceEffects.truncate_context_to_tokens.
   */
  max_context_tokens?: number;
  /**
   * If true, long-term persistence (HSG/Vector) should be disabled for
   * the evaluated operation.
   */
  forbid_long_term_persist?: boolean;

  // TODO(MEM-NEXT.*): extension point for additional memory-related
  // constraints (e.g. override_memory_mode) once PolicyEngine contracts
  // are extended. Do not add new fields here in MEM-NEXT.1.
}

export interface UpstreamPolicyDecision {
  status: UpstreamPolicyDecisionStatus;
  reasons: string[];
  constraints?: UpstreamPolicyConstraints;
  audit_ref?: string;
  /**
   * Optional identifier of the underlying PolicyEngine evaluation.
   *
   * When populated by an Infrastructure adapter, this MUST align with
   * `policy.evaluate.*.policy_evaluation_id` typed events.
   */
  policy_evaluation_id?: string;
}

/**
 * Adapter used by Memory Governance to query the global PolicyEngine.
 *
 * NOTE:
 * - Real implementations will live in Infrastructure layer and should
 *   be wired via DI, behind this Memory-layer port.
 */
export interface IMemoryPolicyEngineAdapter {
  evaluate(request: MemoryGovernanceRequest): Promise<UpstreamPolicyDecision>;
}

/**
 * Stub adapter for MEM-NEXT.1 MVP.
 *
 * IMPORTANT:
 * - This implementation must be easy to replace with a real PolicyEngine
 *   integration and therefore MUST NOT leak any infra-specific details.
 * - It is intentionally permissive and always returns "allow".
 */
export class AllowAllMemoryPolicyEngineAdapter implements IMemoryPolicyEngineAdapter {
  async evaluate(_request: MemoryGovernanceRequest): Promise<UpstreamPolicyDecision> {
    return {
      status: 'allow',
      reasons: ['policy_engine_stub_allow_all'],
    };
  }
}