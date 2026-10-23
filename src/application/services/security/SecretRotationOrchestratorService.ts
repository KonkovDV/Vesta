import type {
  ISecretRotationPlanner,
  SecretRotationRequest,
} from '@/domain/security/secret-rotation-planner.port';
import type {
  ISecretRotationExecutor,
  SecretRotationExecutionResult,
} from '@/domain/security/secret-rotation-executor.port';
import type {
  ISecretRotationReceiptStore,
  SecretRotationReceipt,
} from '@/domain/security/secret-rotation-receipt-store.port';
import { IdGenerator } from '@/core/utils/IdGenerator';

interface ILogger {
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
}

export class SecretRotationOrchestratorService {
  constructor(
    private readonly planner: ISecretRotationPlanner,
    private readonly executor: ISecretRotationExecutor,
    private readonly receiptStore: ISecretRotationReceiptStore,
    private readonly logger?: ILogger,
  ) {}

  async rotate(request: SecretRotationRequest): Promise<SecretRotationReceipt> {
    const plan = await this.planner.createPlan(request);
    const execution = await this.executor.execute(plan);

    const finalExecution = this.shouldRollback(execution)
      ? await this.executor.rollback(plan, execution)
      : execution;

    const receipt: SecretRotationReceipt = {
      receiptId: IdGenerator.generateWithPrefix('secret-rotation-receipt'),
      planId: plan.planId,
      correlationId: plan.correlationId,
      requestedBy: plan.requestedBy,
      targetIds: plan.targets.map((target) => target.id),
      dryRun: plan.dryRun,
      createdAt: new Date(),
      status: finalExecution.status,
      execution: finalExecution,
    };

    await this.receiptStore.save(receipt);

    if (finalExecution.status === 'rolled_back') {
      this.logger?.warn?.('secret_rotation_rolled_back', {
        correlationId: receipt.correlationId,
        planId: receipt.planId,
        targetIds: receipt.targetIds,
      });
    } else {
      this.logger?.info?.('secret_rotation_completed', {
        correlationId: receipt.correlationId,
        planId: receipt.planId,
        targetIds: receipt.targetIds,
        dryRun: receipt.dryRun,
      });
    }

    return receipt;
  }

  private shouldRollback(execution: SecretRotationExecutionResult): boolean {
    return execution.status === 'failed' && execution.failedStage !== 'finalize';
  }
}