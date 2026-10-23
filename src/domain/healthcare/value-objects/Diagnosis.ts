import { ValueObject } from '../../../core/domain/ValueObject';
import { DomainInvariantViolationError } from '../../errors/DomainError';

interface DiagnosisProps {
  primaryCondition: string;
  confidence: number;
  rationale: string[];
  recommendations: string[];
}

export class Diagnosis extends ValueObject<DiagnosisProps> {
  private constructor(props: DiagnosisProps) {
    super(props);
  }

  static create(
    primaryCondition: string, 
    confidence: number, 
    rationale: string[],
    recommendations: string[] = []
  ): Diagnosis {
    if (confidence < 0 || confidence > 1) {
      throw new DomainInvariantViolationError(
        'DIAGNOSIS_INVALID_CONFIDENCE',
        'Confidence must be between 0 and 1',
        { metadata: { confidence } }
      );
    }

    if (primaryCondition.trim().length === 0) {
       throw new DomainInvariantViolationError(
        'DIAGNOSIS_EMPTY_CONDITION',
        'Primary condition cannot be empty',
        {}
      );
    }

    return new Diagnosis({
      primaryCondition: primaryCondition.trim(),
      confidence,
      rationale,
      recommendations
    });
  }

  get primaryCondition(): string {
    return this.props.primaryCondition;
  }

  get confidence(): number {
    return this.props.confidence;
  }

  get rationale(): readonly string[] {
    return this.props.rationale;
  }

  get recommendations(): readonly string[] {
    return this.props.recommendations;
  }
}
