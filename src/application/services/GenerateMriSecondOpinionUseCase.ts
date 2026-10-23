import { IMriSecondOpinionCaseRepository } from '../../domain/healthcare/ports/IMriSecondOpinionCaseRepository';
import {
  ISecondOpinionInferenceService,
} from '../../domain/healthcare/ports/ISecondOpinionInferenceService';
import { IClinicalSafetyPolicy } from '../../domain/healthcare/ports/IClinicalSafetyPolicy';
import { MriSecondOpinionCase } from '../../domain/healthcare/aggregates/MriSecondOpinionCase';
import { ImagingStudyRef } from '../../domain/healthcare/value-objects/ImagingStudyRef';
import { ClinicalQuestion } from '../../domain/healthcare/value-objects/ClinicalQuestion';
import { RadiologyReportSummary } from '../../domain/healthcare/value-objects/RadiologyReportSummary';

/**
 * Use Case: Generate MRI Second Opinion
 *
 * Orchestrates the CDS "second opinion" workflow:
 * 1. Submit imaging study + clinical question → create aggregate
 * 2. Invoke AI inference service → structured assessment
 * 3. Run clinical safety policy evaluation → flag unsafe findings
 * 4. Persist aggregate with events (Outbox-first)
 * 5. Return case awaiting human review (clinician-review boundary aligned with FDA CDS guidance)
 *
 * The use case intentionally does NOT finalize the case.
 * Human review and finalization are separate bounded operations
 * triggered by the reviewing physician.
 *
 * @layer Application
 * @see docs/superpowers/specs/2026-03-23-mri-second-opinion-design.md
 */

export interface GenerateMriSecondOpinionInput {
  readonly study: ImagingStudyRef;
  readonly clinicalQuestion: ClinicalQuestion;
  readonly originalReport?: RadiologyReportSummary;
  readonly correlationId?: string;
}

export interface GenerateMriSecondOpinionOutput {
  readonly caseId: string;
  readonly status: string;
  readonly agreementLevel: string;
  readonly confidenceBand: string;
  readonly safetyFlagCount: number;
  readonly hasBlockingFlags: boolean;
  readonly modelId: string;
  readonly inferenceLatencyMs: number;
}

export class GenerateMriSecondOpinionUseCase {
  constructor(
    private readonly repository: IMriSecondOpinionCaseRepository,
    private readonly inferenceService: ISecondOpinionInferenceService,
    private readonly safetyPolicy: IClinicalSafetyPolicy,
  ) {}

  async execute(input: GenerateMriSecondOpinionInput): Promise<GenerateMriSecondOpinionOutput> {
    // 1. Create aggregate via factory
    const mriCase = MriSecondOpinionCase.submit(
      input.study,
      input.clinicalQuestion,
      input.originalReport,
      input.correlationId,
    );

    // 2. Run AI inference
    const inferenceResult = await this.inferenceService.generateSecondOpinion(
      input.study,
      input.clinicalQuestion,
      input.originalReport,
    );

    // 3. Transition aggregate: Submitted → AwaitingReview
    mriCase.completeInference(
      inferenceResult.assessment,
      inferenceResult.modelId,
      inferenceResult.latencyMs,
      input.correlationId,
    );

    // 4. Evaluate clinical safety policy
    const safetyResult = await this.safetyPolicy.evaluate(
      inferenceResult.assessment,
      input.study,
      input.clinicalQuestion,
    );

    // 5. Raise safety flags if any
    for (const flag of safetyResult.flags) {
      mriCase.raiseSafetyFlag(
        flag.flagCode,
        flag.severity,
        flag.description,
        flag.blocksDelivery,
        input.correlationId,
      );
    }

    // 6. Persist aggregate with domain events (Outbox-first)
    await this.repository.save(mriCase);

    // 7. Return result for human review workflow
    return {
      caseId: mriCase.id.toString(),
      status: mriCase.status,
      agreementLevel: inferenceResult.assessment.agreementLevel,
      confidenceBand: inferenceResult.assessment.confidenceBand,
      safetyFlagCount: mriCase.safetyFlags.length,
      hasBlockingFlags: mriCase.hasBlockingSafetyFlags,
      modelId: inferenceResult.modelId,
      inferenceLatencyMs: inferenceResult.latencyMs,
    };
  }
}
