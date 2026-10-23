import type {
  ISecretRotationExecutor,
  SecretRotationExecutionResult,
  SecretRotationStageResult,
} from '@/domain/security/secret-rotation-executor.port';
import type { SecretRotationPlan } from '@/domain/security/secret-rotation-planner.port';

export class DryRunSecretRotationExecutorAdapter implements ISecretRotationExecutor {
  async execute(plan: SecretRotationPlan): Promise<SecretRotationExecutionResult> {
    const startedAt = new Date();
    const stageResults = this.buildStageResults(plan, 'dry-run simulated successfully');

    return {
      planId: plan.planId,
      correlationId: plan.correlationId,
      status: 'completed',
      stageResults,
      startedAt,
      finishedAt: new Date(),
    };
  }

  async rollback(
    plan: SecretRotationPlan,
    failedExecution: SecretRotationExecutionResult,
  ): Promise<SecretRotationExecutionResult> {
    const startedAt = new Date();
    const failedStage = failedExecution.failedStage ?? 'verify';

    return {
      planId: plan.planId,
      correlationId: plan.correlationId,
      status: 'rolled_back',
      failedStage,
      stageResults: [
        {
          stage: failedStage,
          targetId: plan.targets[0]?.id ?? 'unknown-target',
          success: true,
          summary: 'dry-run rollback completed',
        },
      ],
      startedAt,
      finishedAt: new Date(),
    };
  }

  private buildStageResults(plan: SecretRotationPlan, summary: string): SecretRotationStageResult[] {
    const results: SecretRotationStageResult[] = [];

    for (const stage of plan.stages) {
      for (const target of plan.targets) {
        results.push({
          stage,
          targetId: target.id,
          success: true,
          summary,
        });
      }
    }

    return results;
  }
}