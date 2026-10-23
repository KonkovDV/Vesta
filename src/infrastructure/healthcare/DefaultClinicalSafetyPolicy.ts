import {
  IClinicalSafetyPolicy,
  SafetyCheckResult,
} from '../../domain/healthcare/ports/IClinicalSafetyPolicy';
import { SecondOpinionAssessment } from '../../domain/healthcare/value-objects/SecondOpinionAssessment';
import { ImagingStudyRef } from '../../domain/healthcare/value-objects/ImagingStudyRef';
import { ClinicalQuestion } from '../../domain/healthcare/value-objects/ClinicalQuestion';

/**
 * Default rule-based implementation of IClinicalSafetyPolicy.
 *
 * Evaluates the AI-generated assessment for clinical safety signals:
 * 1. Low confidence → warning flag
 * 2. Significant disagreement with original report → blocking flag
 * 3. "Cannot determine" agreement level → blocking flag
 * 4. STAT urgency cases with low confidence → blocking flag
 *
 * Academic basis:
 * - ACR Practice Parameters for Communication (Res. 11, 2020)
 * - Larson et al. (2021) "Regulatory Frameworks for AI in Radiology" (AJR)
 * - FDA CDS guidance and FD&C Act section 520(o)(1)(E) — clinician review boundary
 *
 * @layer Infrastructure
 */
export class DefaultClinicalSafetyPolicy implements IClinicalSafetyPolicy {
  async evaluate(
    assessment: SecondOpinionAssessment,
    _study: ImagingStudyRef,
    clinicalQuestion: ClinicalQuestion,
  ): Promise<SafetyCheckResult> {
    const flags: Array<{
      flagCode: string;
      severity: 'info' | 'warning' | 'critical';
      description: string;
      blocksDelivery: boolean;
    }> = [];

    // Rule 1: Low confidence band → warning
    if (assessment.confidenceBand === 'low') {
      flags.push({
        flagCode: 'SAFETY_LOW_CONFIDENCE',
        severity: 'warning',
        description: 'AI assessment has low confidence — requires careful human review',
        blocksDelivery: false,
      });
    }

    if (clinicalQuestion.urgency === 'stat' && assessment.confidenceBand === 'low') {
      flags.push({
        flagCode: 'SAFETY_STAT_LOW_CONFIDENCE',
        severity: 'critical',
        description: 'STAT study with low-confidence AI assessment requires immediate human escalation before delivery',
        blocksDelivery: true,
      });
    }

    // Rule 2: Insufficient data → blocks delivery (cannot make clinical decision)
    if (assessment.confidenceBand === 'insufficient_data') {
      flags.push({
        flagCode: 'SAFETY_INSUFFICIENT_DATA',
        severity: 'critical',
        description: 'AI assessment has insufficient data for clinical confidence — delivery blocked',
        blocksDelivery: true,
      });
    }

    // Rule 3: Significant disagreement → blocks delivery (ACR communication requirement)
    if (assessment.agreementLevel === 'significant_disagreement') {
      flags.push({
        flagCode: 'SAFETY_SIGNIFICANT_DISAGREEMENT',
        severity: 'critical',
        description: 'Significant disagreement between AI and original report — requires reconciliation per ACR guidelines',
        blocksDelivery: true,
      });
    }

    // Rule 4: Cannot determine agreement → blocks delivery
    if (assessment.agreementLevel === 'cannot_determine') {
      flags.push({
        flagCode: 'SAFETY_CANNOT_DETERMINE',
        severity: 'critical',
        description: 'AI could not determine agreement level — manual assessment required',
        blocksDelivery: true,
      });
    }

    return {
      passed: flags.length === 0,
      flags,
    };
  }
}
