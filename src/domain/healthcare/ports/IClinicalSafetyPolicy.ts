import { SecondOpinionAssessment } from '../value-objects/SecondOpinionAssessment';
import { ImagingStudyRef } from '../value-objects/ImagingStudyRef';
import { ClinicalQuestion } from '../value-objects/ClinicalQuestion';

/**
 * Port for clinical safety policy evaluation.
 *
 * Evaluates whether an AI-generated assessment contains
 * safety-critical signals that require flagging, escalation,
 * or delivery blocking.
 *
 * Safety signals include:
 * - Critical/urgent findings requiring immediate attention
 * - Discrepant findings between AI and original report
 * - Low-confidence assessments below clinical threshold
 * - Known contraindications or critical follow-up recommendations
 *
 * References:
 * - ACR Practice Parameters for Communication (Res. 11, 2020)
 * - FDA CDS guidance and FD&C Act section 520(o)(1)(E) — clinician review boundary
 *
 * @layer Domain (port)
 */

export interface SafetyCheckResult {
  readonly passed: boolean;
  readonly flags: ReadonlyArray<{
    readonly flagCode: string;
    readonly severity: 'info' | 'warning' | 'critical';
    readonly description: string;
    readonly blocksDelivery: boolean;
  }>;
}

export interface IClinicalSafetyPolicy {
  /**
   * Evaluate assessment for clinical safety signals.
   *
   * @param assessment - The AI-generated second opinion
   * @param study - The imaging study reference for context
   * @param clinicalQuestion - Clinical intent and urgency for escalation logic
   * @returns Safety check result with any flags
   */
  evaluate(
    assessment: SecondOpinionAssessment,
    study: ImagingStudyRef,
    clinicalQuestion: ClinicalQuestion,
  ): Promise<SafetyCheckResult>;
}
