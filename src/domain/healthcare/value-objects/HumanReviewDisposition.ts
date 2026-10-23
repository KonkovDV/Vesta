import { ValueObject } from '../../../core/domain/ValueObject';
import { DomainInvariantViolationError } from '../../errors/DomainError';

/**
 * Human radiologist/physician review disposition.
 *
 * Records the clinical decision made by a qualified human reviewer
 * after examining the AI-generated second opinion. This is the
 * "human in the loop" gate aligned with FDA CDS guidance and
 * section 520(o)(1)(E) of the FD&C Act.
 *
 * Invariants:
 * - reviewerRole must be non-empty
 * - decision must be a valid enum value
 * - reviewedAt must be a valid ISO 8601 datetime
 */

export type ReviewDecision = 'accepted' | 'modified' | 'rejected' | 'escalated';

interface HumanReviewDispositionProps {
  readonly reviewerRole: string;
  readonly decision: ReviewDecision;
  readonly modifications?: string;
  readonly clinicalNotes?: string;
  readonly reviewedAt: Date;
}

export class HumanReviewDisposition extends ValueObject<HumanReviewDispositionProps> {
  private constructor(props: HumanReviewDispositionProps) {
    super(props);
  }

  static create(props: {
    reviewerRole: string;
    decision: ReviewDecision;
    modifications?: string;
    clinicalNotes?: string;
    reviewedAt: Date;
  }): HumanReviewDisposition {
    const trimmedRole = props.reviewerRole.trim();

    if (trimmedRole.length === 0) {
      throw new DomainInvariantViolationError(
        'REVIEW_EMPTY_ROLE',
        'Reviewer role must be non-empty (e.g. "Neuroradiologist", "Attending Physician")',
        {}
      );
    }

    return new HumanReviewDisposition({
      reviewerRole: trimmedRole,
      decision: props.decision,
      modifications: props.modifications?.trim(),
      clinicalNotes: props.clinicalNotes?.trim(),
      reviewedAt: props.reviewedAt,
    });
  }

  get reviewerRole(): string { return this.props.reviewerRole; }
  get decision(): ReviewDecision { return this.props.decision; }
  get modifications(): string | undefined { return this.props.modifications; }
  get clinicalNotes(): string | undefined { return this.props.clinicalNotes; }
  get reviewedAt(): Date { return this.props.reviewedAt; }
}
