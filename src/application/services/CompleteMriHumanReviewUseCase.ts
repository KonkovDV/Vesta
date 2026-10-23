import { EntityNotFoundError } from '../../domain/errors/DomainError';
import { IMriSecondOpinionCaseRepository } from '../../domain/healthcare/ports/IMriSecondOpinionCaseRepository';
import { HumanReviewDisposition } from '../../domain/healthcare/value-objects/HumanReviewDisposition';
import { SecondOpinionAssessment } from '../../domain/healthcare/value-objects/SecondOpinionAssessment';

export interface CompleteMriHumanReviewInput {
  readonly caseId: string;
  readonly disposition: HumanReviewDisposition;
  readonly finalAssessment?: SecondOpinionAssessment;
  readonly correlationId?: string;
}

export interface CompleteMriHumanReviewOutput {
  readonly caseId: string;
  readonly status: string;
  readonly decision: string;
  readonly hasBlockingFlags: boolean;
}

export class CompleteMriHumanReviewUseCase {
  constructor(
    private readonly repository: IMriSecondOpinionCaseRepository,
  ) {}

  async execute(input: CompleteMriHumanReviewInput): Promise<CompleteMriHumanReviewOutput> {
    const mriCase = await this.repository.findById(input.caseId);

    if (!mriCase) {
      throw new EntityNotFoundError('MriSecondOpinionCase', input.caseId, {
        correlationId: input.correlationId,
      });
    }

    mriCase.completeHumanReview(
      input.disposition,
      input.finalAssessment,
      input.correlationId,
    );

    await this.repository.save(mriCase);

    return {
      caseId: mriCase.id.toString(),
      status: mriCase.status,
      decision: input.disposition.decision,
      hasBlockingFlags: mriCase.hasBlockingSafetyFlags,
    };
  }
}