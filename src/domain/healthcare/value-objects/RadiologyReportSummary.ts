import { ValueObject } from '../../../core/domain/ValueObject';
import { DomainInvariantViolationError } from '../../errors/DomainError';

/**
 * Structured summary of a radiology report.
 *
 * Aligned with ACR Practice Parameters for Communication
 * of Diagnostic Imaging Findings (Res. 11, 2020) and
 * RSNA RadReport template structure.
 *
 * Supports optional RadLex and SNOMED CT coded entries
 * for standardized terminology.
 *
 * Invariants:
 * - findings and impression must be non-empty
 */

interface RadiologyReportSummaryProps {
  readonly findings: string;
  readonly impression: string;
  readonly assessmentCategory?: string;
  readonly radLexCodes: readonly string[];
  readonly snomedCodes: readonly string[];
}

export class RadiologyReportSummary extends ValueObject<RadiologyReportSummaryProps> {
  private constructor(props: RadiologyReportSummaryProps) {
    super(props);
  }

  static create(props: {
    findings: string;
    impression: string;
    assessmentCategory?: string;
    radLexCodes?: string[];
    snomedCodes?: string[];
  }): RadiologyReportSummary {
    const trimmedFindings = props.findings.trim();
    const trimmedImpression = props.impression.trim();

    if (trimmedFindings.length === 0) {
      throw new DomainInvariantViolationError(
        'REPORT_EMPTY_FINDINGS',
        'Radiology report findings must be non-empty',
        {}
      );
    }

    if (trimmedImpression.length === 0) {
      throw new DomainInvariantViolationError(
        'REPORT_EMPTY_IMPRESSION',
        'Radiology report impression must be non-empty',
        {}
      );
    }

    return new RadiologyReportSummary({
      findings: trimmedFindings,
      impression: trimmedImpression,
      assessmentCategory: props.assessmentCategory?.trim(),
      radLexCodes: Object.freeze([...(props.radLexCodes ?? [])]),
      snomedCodes: Object.freeze([...(props.snomedCodes ?? [])]),
    });
  }

  get findings(): string { return this.props.findings; }
  get impression(): string { return this.props.impression; }
  get assessmentCategory(): string | undefined { return this.props.assessmentCategory; }
  get radLexCodes(): readonly string[] { return this.props.radLexCodes; }
  get snomedCodes(): readonly string[] { return this.props.snomedCodes; }
}
