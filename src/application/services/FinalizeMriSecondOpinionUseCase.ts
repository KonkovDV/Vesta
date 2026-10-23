import { EntityNotFoundError } from '../../domain/errors/DomainError';
import type { IMriDeliveryJobQueue } from '../../domain/healthcare/ports/IMriDeliveryJobQueue';
import { IMriSecondOpinionCaseRepository } from '../../domain/healthcare/ports/IMriSecondOpinionCaseRepository';
import { IdGenerator } from '../../core/utils/IdGenerator';

export interface FinalizeMriSecondOpinionInput {
  readonly caseId: string;
  readonly outcome: 'delivered' | 'withdrawn' | 'expired';
  readonly finalSummary: string;
  readonly correlationId?: string;
}

export interface FinalizeMriSecondOpinionOutput {
  readonly caseId: string;
  readonly status: string;
  readonly outcome: 'delivered' | 'withdrawn' | 'expired';
  readonly hasBlockingFlags: boolean;
}

export class FinalizeMriSecondOpinionUseCase {
  constructor(
    private readonly repository: IMriSecondOpinionCaseRepository,
    private readonly deliveryJobQueue?: IMriDeliveryJobQueue,
  ) {}

  async execute(input: FinalizeMriSecondOpinionInput): Promise<FinalizeMriSecondOpinionOutput> {
    const mriCase = await this.repository.findById(input.caseId);

    if (!mriCase) {
      throw new EntityNotFoundError('MriSecondOpinionCase', input.caseId, {
        correlationId: input.correlationId,
      });
    }

    mriCase.finalize(input.outcome, input.finalSummary, input.correlationId);

    await this.repository.save(mriCase);

    if (input.outcome === 'delivered' && this.deliveryJobQueue) {
      await this.deliveryJobQueue.enqueue({
        jobId: IdGenerator.generateWithPrefix('mri_delivery'),
        caseId: mriCase.id.toString(),
        correlationId: input.correlationId,
        requestedAt: new Date().toISOString(),
      });
    }

    return {
      caseId: mriCase.id.toString(),
      status: mriCase.status,
      outcome: input.outcome,
      hasBlockingFlags: mriCase.hasBlockingSafetyFlags,
    };
  }
}