import { ValueObject } from '../../../core/domain/ValueObject';
import { DomainInvariantViolationError } from '../../errors/DomainError';

/**
 * AI-generated second opinion assessment.
 *
 * Modeled after PI-RADS v2.1 / BI-RADS 5th Edition / LI-RADS v2018
 * structured assessment categories. Uses agreementLevel and confidenceBand
 * rather than numeric scores to reflect clinical interpretive nuance.
 *
 * Invariants:
 * - summary and at least one finding must be present
 * - agreementLevel must be a valid enum value
 * - confidenceBand must be a valid enum value
 */

export type AgreementLevel =
  | 'full_agreement'
  | 'partial_agreement'
  | 'significant_disagreement'
  | 'cannot_determine';

export type ConfidenceBand = 'high' | 'moderate' | 'low' | 'insufficient_data';

interface SecondOpinionAssessmentProps {
  readonly summary: string;
  readonly findings: readonly string[];
  readonly agreementLevel: AgreementLevel;
  readonly confidenceBand: ConfidenceBand;
  readonly differentialDiagnoses: readonly string[];
  readonly recommendations: readonly string[];
  readonly limitations: readonly string[];
  readonly citedReferences: readonly string[];
}

export class SecondOpinionAssessment extends ValueObject<SecondOpinionAssessmentProps> {
  private constructor(props: SecondOpinionAssessmentProps) {
    super(props);
  }

  static create(props: {
    summary: string;
    findings: string[];
    agreementLevel: AgreementLevel;
    confidenceBand: ConfidenceBand;
    differentialDiagnoses?: string[];
    recommendations?: string[];
    limitations?: string[];
    citedReferences?: string[];
  }): SecondOpinionAssessment {
    const trimmedSummary = props.summary.trim();

    if (trimmedSummary.length === 0) {
      throw new DomainInvariantViolationError(
        'ASSESSMENT_EMPTY_SUMMARY',
        'Second opinion assessment summary must be non-empty',
        {}
      );
    }

    if (props.findings.length === 0) {
      throw new DomainInvariantViolationError(
        'ASSESSMENT_NO_FINDINGS',
        'Second opinion assessment must contain at least one finding',
        {}
      );
    }

    return new SecondOpinionAssessment({
      summary: trimmedSummary,
      findings: Object.freeze([...props.findings]),
      agreementLevel: props.agreementLevel,
      confidenceBand: props.confidenceBand,
      differentialDiagnoses: Object.freeze([...(props.differentialDiagnoses ?? [])]),
      recommendations: Object.freeze([...(props.recommendations ?? [])]),
      limitations: Object.freeze([...(props.limitations ?? [])]),
      citedReferences: Object.freeze([...(props.citedReferences ?? [])]),
    });
  }

  get summary(): string { return this.props.summary; }
  get findings(): readonly string[] { return this.props.findings; }
  get agreementLevel(): AgreementLevel { return this.props.agreementLevel; }
  get confidenceBand(): ConfidenceBand { return this.props.confidenceBand; }
  get differentialDiagnoses(): readonly string[] { return this.props.differentialDiagnoses; }
  get recommendations(): readonly string[] { return this.props.recommendations; }
  get limitations(): readonly string[] { return this.props.limitations; }
  get citedReferences(): readonly string[] { return this.props.citedReferences; }
}
