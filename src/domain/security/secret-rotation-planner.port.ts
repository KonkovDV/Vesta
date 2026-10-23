/**
 * Secret Rotation Planner Domain Port
 *
 * Creates deterministic dry-run-safe plans for the current inventory of
 * secrets. Provider-specific mutation is delegated to the executor.
 *
 * @layer Domain
 */

import type { SecretRotationTarget } from './secret-inventory.port';

export type SecretRotationStage = 'prepare' | 'apply' | 'verify' | 'finalize';

export interface SecretRotationRequest {
  readonly correlationId: string;
  readonly requestedBy: string;
  readonly dryRun: boolean;
  readonly reason: string;
  readonly targetIds: readonly string[];
}

export interface SecretRotationPlan {
  readonly planId: string;
  readonly correlationId: string;
  readonly requestedBy: string;
  readonly dryRun: boolean;
  readonly reason: string;
  readonly createdAt: Date;
  readonly targets: SecretRotationTarget[];
  readonly stages: SecretRotationStage[];
}

export interface ISecretRotationPlanner {
  createPlan(request: SecretRotationRequest): Promise<SecretRotationPlan>;
}