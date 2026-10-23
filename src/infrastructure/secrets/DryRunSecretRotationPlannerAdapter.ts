import type { ISecretInventory } from '@/domain/security/secret-inventory.port';
import { ValidationError } from '@/domain/errors/DomainError';
import type {
  ISecretRotationPlanner,
  SecretRotationPlan,
  SecretRotationRequest,
} from '@/domain/security/secret-rotation-planner.port';

export class DryRunSecretRotationPlannerAdapter implements ISecretRotationPlanner {
  constructor(private readonly inventory: ISecretInventory) {}

  async createPlan(request: SecretRotationRequest): Promise<SecretRotationPlan> {
    const targets = await this.inventory.getTargetsByIds(request.targetIds);
    const requestedIds = Array.from(new Set(request.targetIds));
    const resolvedIds = new Set(targets.map((target) => target.id));
    const missingIds = requestedIds.filter((targetId) => !resolvedIds.has(targetId));

    if (missingIds.length > 0) {
      throw new ValidationError(
        `Unknown secret rotation targets: ${missingIds.join(', ')}`,
        missingIds.map((targetId) => ({
          field: 'targetIds',
          message: `Unknown secret rotation target: ${targetId}`,
          value: targetId,
        })),
        {
          correlationId: request.correlationId,
          metadata: {
            requestedBy: request.requestedBy,
          },
        },
      );
    }

    return {
      planId: `plan-${request.correlationId}`,
      correlationId: request.correlationId,
      requestedBy: request.requestedBy,
      dryRun: request.dryRun,
      reason: request.reason,
      createdAt: new Date(),
      targets,
      stages: ['prepare', 'apply', 'verify', 'finalize'],
    };
  }
}