/**
 * Secret Rotation Executor Domain Port
 *
 * Executes or simulates a prepared rotation plan. The first implementation is
 * dry-run only and produces auditable stage-by-stage results.
 *
 * @layer Domain
 */

import type { SecretRotationPlan, SecretRotationStage } from './secret-rotation-planner.port';

export type SecretRotationExecutionStatus = 'completed' | 'failed' | 'rolled_back';

export interface SecretRotationStageResult {
  readonly stage: SecretRotationStage;
  readonly targetId: string;
  readonly success: boolean;
  readonly summary: string;
}

export interface SecretRotationExecutionResult {
  readonly planId: string;
  readonly correlationId: string;
  readonly status: SecretRotationExecutionStatus;
  readonly failedStage?: SecretRotationStage;
  readonly stageResults: SecretRotationStageResult[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export interface ISecretRotationExecutor {
  execute(plan: SecretRotationPlan): Promise<SecretRotationExecutionResult>;
  rollback(
    plan: SecretRotationPlan,
    failedExecution: SecretRotationExecutionResult,
  ): Promise<SecretRotationExecutionResult>;
}