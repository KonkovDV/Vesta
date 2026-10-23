/**
 * IAutonomyLevel — Domain interface for configurable Human-In-The-Loop control.
 *
 * Determines whether an agent action requires human approval based on:
 * - Default autonomy mode (autonomous / supervised / manual)
 * - Per-risk-level overrides
 * - Per-tool-name overrides
 *
 * Consulted BEFORE IUserApprovalInterceptor — if autonomy level says
 * "autonomous", the approval step is skipped entirely.
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @see Book Ch.13 "Human-in-the-Loop" — configurable HITL
 * @see CC-12 (Master Plan §8.12)
 */

import type { CorrelationId } from '@/ai-types';

/**
 * Autonomy mode for agent actions.
 */
export type AutonomyMode = 'autonomous' | 'supervised' | 'manual';

/**
 * Risk level for agent actions. Aligns with IToolExecutionPolicy risk classification.
 */
export type ActionRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Configuration for autonomy levels.
 */
export interface AutonomyConfig {
  readonly defaultMode: AutonomyMode;
  readonly perRiskLevel?: Partial<Record<ActionRiskLevel, AutonomyMode>>;
  readonly perToolName?: Partial<Record<string, AutonomyMode>>;
}

/**
 * Configurable HITL autonomy control.
 * Lifecycle: singleton.
 */
export interface IAutonomyLevel {
  /** Get the effective autonomy mode for a specific action and risk level. */
  getMode(action: string, riskLevel: ActionRiskLevel): AutonomyMode;

  /** Check if an action at a given risk level requires human approval. */
  requiresApproval(action: string, riskLevel: ActionRiskLevel): boolean;

  /** Update autonomy configuration at runtime. */
  configure(config: AutonomyConfig, correlationId: CorrelationId): void;
}
