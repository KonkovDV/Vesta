import { AggregateRoot, DomainEvent } from '../../../core/domain/AggregateRoot';
import { EntityId } from '../../../core/types';
import { DomainInvariantViolationError } from '../../errors/DomainError';
import { ImagingStudyRef } from '../value-objects/ImagingStudyRef';
import { ClinicalQuestion } from '../value-objects/ClinicalQuestion';
import { RadiologyReportSummary } from '../value-objects/RadiologyReportSummary';
import { SecondOpinionAssessment } from '../value-objects/SecondOpinionAssessment';
import { HumanReviewDisposition } from '../value-objects/HumanReviewDisposition';
import {
  createMriStudySubmittedEvent,
  createMriInferenceCompletedEvent,
  createMriHumanReviewCompletedEvent,
  createMriCaseFinalizedEvent,
  createMriSafetyFlagRaisedEvent,
  isMriStudySubmittedEvent,
  isMriInferenceCompletedEvent,
  isMriHumanReviewCompletedEvent,
  isMriCaseFinalizedEvent,
  isMriSafetyFlagRaisedEvent,
} from '../events/mri-second-opinion.events';

/**
 * MRI Second Opinion Case — aggregate root for the CDS "second opinion" workflow.
 *
 * Lifecycle: Submitted → AwaitingReview → Reviewed → Finalized
 *
 * Invariants:
 * - Cannot complete inference before study is submitted
 * - Cannot complete human review before inference
 * - Cannot finalize without human review (clinician review boundary; see FDA CDS guidance)
 * - Safety flags can be raised at any non-finalized state
 * - Delivery is blocked if any critical safety flag exists
 *
 * @see docs/superpowers/specs/2026-03-23-mri-second-opinion-design.md
 */

export type MriCaseStatus =
  | 'Submitted'
  | 'AwaitingReview'
  | 'Reviewed'
  | 'Finalized';

export interface SafetyFlag {
  readonly flagCode: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly description: string;
  readonly blocksDelivery: boolean;
}

export interface MriSecondOpinionCaseProps {
  study: ImagingStudyRef;
  clinicalQuestion: ClinicalQuestion;
  originalReport: RadiologyReportSummary | null;
  assessment: SecondOpinionAssessment | null;
  humanReview: HumanReviewDisposition | null;
  status: MriCaseStatus;
  safetyFlags: readonly SafetyFlag[];
  finalOutcome: string | null;
  finalSummary: string | null;
  modelId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class MriSecondOpinionCase extends AggregateRoot<MriSecondOpinionCaseProps> {
  private constructor(id: EntityId, props: MriSecondOpinionCaseProps, version: number) {
    super(id, props, version);
  }

  // ── Factory ────────────────────────────────────────────────────

  static submit(
    study: ImagingStudyRef,
    clinicalQuestion: ClinicalQuestion,
    originalReport?: RadiologyReportSummary,
    correlationId?: string,
  ): MriSecondOpinionCase {
    const id = EntityId.random();
    const now = new Date();

    const props: MriSecondOpinionCaseProps = {
      study,
      clinicalQuestion,
      originalReport: originalReport ?? null,
      assessment: null,
      humanReview: null,
      status: 'Submitted',
      safetyFlags: [],
      finalOutcome: null,
      finalSummary: null,
      modelId: null,
      createdAt: now,
      updatedAt: now,
    };

    const caseAggregate = new MriSecondOpinionCase(id, props, 1);

    const event = createMriStudySubmittedEvent(id, 1, {
      study: {
        studyInstanceUid: study.studyInstanceUid,
        modality: study.modality,
        bodyPartExamined: study.bodyPartExamined,
        studyDate: study.studyDate.toISOString(),
        seriesCount: study.seriesCount,
        instanceCount: study.instanceCount,
      },
      clinicalQuestion: {
        questionText: clinicalQuestion.questionText,
        urgency: clinicalQuestion.urgency,
        ...(clinicalQuestion.clinicalContext ? { clinicalContext: clinicalQuestion.clinicalContext } : {}),
        priorStudyUids: [...clinicalQuestion.priorStudyUids],
      },
      ...(originalReport
        ? {
            originalReport: {
              findings: originalReport.findings,
              impression: originalReport.impression,
              ...(originalReport.assessmentCategory
                ? { assessmentCategory: originalReport.assessmentCategory }
                : {}),
              radLexCodes: [...originalReport.radLexCodes],
              snomedCodes: [...originalReport.snomedCodes],
            },
          }
        : {}),
    }, correlationId);

    caseAggregate.addEvent(event);

    return caseAggregate;
  }

  // ── Commands ───────────────────────────────────────────────────

  completeInference(
    assessment: SecondOpinionAssessment,
    modelId: string,
    inferenceLatencyMs: number,
    correlationId?: string,
  ): void {
    if (this.props.status !== 'Submitted') {
      throw new DomainInvariantViolationError(
        'MRI_CASE_INVALID_STATE_FOR_INFERENCE',
        `Cannot complete inference in state '${this.props.status}'. Expected 'Submitted'.`,
        { metadata: { currentStatus: this.props.status } }
      );
    }

    const nextVersion = this._version + 1;

    this.setProps({
      ...this.props,
      assessment,
      modelId,
      status: 'AwaitingReview',
      updatedAt: new Date(),
    });
    this._version = nextVersion;

    const event = createMriInferenceCompletedEvent(this.id, nextVersion, {
      assessment: {
        summary: assessment.summary,
        findings: [...assessment.findings],
        agreementLevel: assessment.agreementLevel,
        confidenceBand: assessment.confidenceBand,
        differentialDiagnoses: [...assessment.differentialDiagnoses],
        recommendations: [...assessment.recommendations],
        limitations: [...assessment.limitations],
        citedReferences: [...assessment.citedReferences],
      },
      modelId,
      inferenceLatencyMs,
    }, correlationId);

    this.addEvent(event);
  }

  completeHumanReview(
    disposition: HumanReviewDisposition,
    updatedAssessment?: SecondOpinionAssessment,
    correlationId?: string,
  ): void {
    if (this.props.status !== 'AwaitingReview') {
      throw new DomainInvariantViolationError(
        'MRI_CASE_INVALID_STATE_FOR_REVIEW',
        `Cannot complete human review in state '${this.props.status}'. Expected 'AwaitingReview'.`,
        { metadata: { currentStatus: this.props.status } }
      );
    }

    const nextVersion = this._version + 1;

    this.setProps({
      ...this.props,
      humanReview: disposition,
      assessment: updatedAssessment ?? this.props.assessment,
      status: 'Reviewed',
      updatedAt: new Date(),
    });
    this._version = nextVersion;

    const event = createMriHumanReviewCompletedEvent(this.id, nextVersion, {
      disposition: {
        reviewerRole: disposition.reviewerRole,
        decision: disposition.decision,
        reviewedAt: disposition.reviewedAt.toISOString(),
        ...(disposition.modifications ? { modifications: disposition.modifications } : {}),
        ...(disposition.clinicalNotes ? { clinicalNotes: disposition.clinicalNotes } : {}),
      },
      ...(updatedAssessment
        ? {
            finalAssessment: {
              summary: updatedAssessment.summary,
              findings: [...updatedAssessment.findings],
              agreementLevel: updatedAssessment.agreementLevel,
              confidenceBand: updatedAssessment.confidenceBand,
              differentialDiagnoses: [...updatedAssessment.differentialDiagnoses],
              recommendations: [...updatedAssessment.recommendations],
              limitations: [...updatedAssessment.limitations],
              citedReferences: [...updatedAssessment.citedReferences],
            },
          }
        : {}),
    }, correlationId);

    this.addEvent(event);
  }

  finalize(
    outcome: 'delivered' | 'withdrawn' | 'expired',
    finalSummary: string,
    correlationId?: string,
  ): void {
    if (this.props.status !== 'Reviewed') {
      throw new DomainInvariantViolationError(
        'MRI_CASE_INVALID_STATE_FOR_FINALIZATION',
        `Cannot finalize case in state '${this.props.status}'. Expected 'Reviewed'.`,
        { metadata: { currentStatus: this.props.status } }
      );
    }

    const hasBlockingFlag = this.props.safetyFlags.some(f => f.blocksDelivery);
    if (outcome === 'delivered' && hasBlockingFlag) {
      throw new DomainInvariantViolationError(
        'MRI_CASE_BLOCKED_BY_SAFETY_FLAG',
        'Cannot deliver case with unresolved critical safety flags',
        { metadata: { blockingFlags: this.props.safetyFlags.filter(f => f.blocksDelivery) } }
      );
    }

    const nextVersion = this._version + 1;

    this.setProps({
      ...this.props,
      status: 'Finalized',
      finalOutcome: outcome,
      finalSummary,
      updatedAt: new Date(),
    });
    this._version = nextVersion;

    const event = createMriCaseFinalizedEvent(this.id, nextVersion, {
      outcome,
      finalSummary,
    }, correlationId);

    this.addEvent(event);
  }

  raiseSafetyFlag(
    flagCode: string,
    severity: 'info' | 'warning' | 'critical',
    description: string,
    blocksDelivery: boolean,
    correlationId?: string,
  ): void {
    if (this.props.status === 'Finalized') {
      throw new DomainInvariantViolationError(
        'MRI_CASE_CANNOT_FLAG_FINALIZED',
        'Cannot raise safety flag on a finalized case',
        {}
      );
    }

    const flag: SafetyFlag = { flagCode, severity, description, blocksDelivery };
    const nextVersion = this._version + 1;

    this.setProps({
      ...this.props,
      safetyFlags: [...this.props.safetyFlags, flag],
      updatedAt: new Date(),
    });
    this._version = nextVersion;

    const event = createMriSafetyFlagRaisedEvent(this.id, nextVersion, {
      flagCode,
      severity,
      description,
      blocksDelivery,
    }, correlationId);

    this.addEvent(event);
  }

  // ── Queries ────────────────────────────────────────────────────

  get study(): ImagingStudyRef { return this.props.study; }
  get clinicalQuestion(): ClinicalQuestion { return this.props.clinicalQuestion; }
  get originalReport(): RadiologyReportSummary | null { return this.props.originalReport; }
  get assessment(): SecondOpinionAssessment | null { return this.props.assessment; }
  get humanReview(): HumanReviewDisposition | null { return this.props.humanReview; }
  get status(): MriCaseStatus { return this.props.status; }
  get safetyFlags(): readonly SafetyFlag[] { return this.props.safetyFlags; }
  get finalOutcome(): string | null { return this.props.finalOutcome; }
  get finalSummary(): string | null { return this.props.finalSummary; }
  get modelId(): string | null { return this.props.modelId; }
  get hasBlockingSafetyFlags(): boolean { return this.props.safetyFlags.some(f => f.blocksDelivery); }

  // ── Event Sourcing Hydration ───────────────────────────────────

  protected when(event: DomainEvent): void {
    if (isMriStudySubmittedEvent(event)) {
      // Initial state already set in factory — no-op for replay
    } else if (isMriInferenceCompletedEvent(event)) {
      // State applied by command — for replay, minimal update
    } else if (isMriHumanReviewCompletedEvent(event)) {
      // no-op: state applied by command
    } else if (isMriCaseFinalizedEvent(event)) {
      // no-op: state applied by command
    } else if (isMriSafetyFlagRaisedEvent(event)) {
      // no-op: state applied by command
    }
  }

  serialize(): Record<string, unknown> {
    return {
      id: this.id.toValue(),
      version: this._version,
      status: this.props.status,
      study: {
        studyInstanceUid: this.props.study.studyInstanceUid,
        modality: this.props.study.modality,
        bodyPartExamined: this.props.study.bodyPartExamined,
        studyDate: this.props.study.studyDate.toISOString(),
        seriesCount: this.props.study.seriesCount,
        instanceCount: this.props.study.instanceCount,
      },
      clinicalQuestion: {
        questionText: this.props.clinicalQuestion.questionText,
        urgency: this.props.clinicalQuestion.urgency,
      },
      assessment: this.props.assessment
        ? {
            summary: this.props.assessment.summary,
            findings: [...this.props.assessment.findings],
            agreementLevel: this.props.assessment.agreementLevel,
            confidenceBand: this.props.assessment.confidenceBand,
          }
        : null,
      humanReview: this.props.humanReview
        ? {
            reviewerRole: this.props.humanReview.reviewerRole,
            decision: this.props.humanReview.decision,
            reviewedAt: this.props.humanReview.reviewedAt.toISOString(),
          }
        : null,
      safetyFlags: this.props.safetyFlags.map(f => ({ ...f })),
      finalOutcome: this.props.finalOutcome,
      finalSummary: this.props.finalSummary,
      modelId: this.props.modelId,
      createdAt: this.props.createdAt.toISOString(),
      updatedAt: this.props.updatedAt.toISOString(),
    };
  }
}
