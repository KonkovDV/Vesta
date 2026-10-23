import { ValueObject } from '../../../core/domain/ValueObject';
import { DomainInvariantViolationError } from '../../errors/DomainError';

/**
 * Clinical question posed by the referring physician.
 *
 * Captures the specific diagnostic concern, clinical context,
 * reference to prior studies, and urgency level.
 *
 * Invariants:
 * - questionText must be non-empty (max 2000 chars)
 * - urgency must be one of: routine, urgent, stat
 */

type Urgency = 'routine' | 'urgent' | 'stat';

interface ClinicalQuestionProps {
  readonly questionText: string;
  readonly clinicalContext?: string;
  readonly priorStudyUids: readonly string[];
  readonly urgency: Urgency;
}

export class ClinicalQuestion extends ValueObject<ClinicalQuestionProps> {
  private constructor(props: ClinicalQuestionProps) {
    super(props);
  }

  static create(props: {
    questionText: string;
    clinicalContext?: string;
    priorStudyUids?: string[];
    urgency: Urgency;
  }): ClinicalQuestion {
    const trimmedQuestion = props.questionText.trim();

    if (trimmedQuestion.length === 0) {
      throw new DomainInvariantViolationError(
        'CLINICAL_QUESTION_EMPTY',
        'Clinical question text must be non-empty',
        {}
      );
    }

    if (trimmedQuestion.length > 2000) {
      throw new DomainInvariantViolationError(
        'CLINICAL_QUESTION_TOO_LONG',
        'Clinical question text must not exceed 2000 characters',
        { metadata: { length: trimmedQuestion.length } }
      );
    }

    return new ClinicalQuestion({
      questionText: trimmedQuestion,
      clinicalContext: props.clinicalContext?.trim(),
      priorStudyUids: Object.freeze([...(props.priorStudyUids ?? [])]),
      urgency: props.urgency,
    });
  }

  get questionText(): string { return this.props.questionText; }
  get clinicalContext(): string | undefined { return this.props.clinicalContext; }
  get priorStudyUids(): readonly string[] { return this.props.priorStudyUids; }
  get urgency(): Urgency { return this.props.urgency; }
}
