import { ValueObject } from '../../../core/domain/ValueObject';
import { DomainInvariantViolationError } from '../../errors/DomainError';

interface SymptomProps {
  value: string;
}

export class Symptom extends ValueObject<SymptomProps> {
  private static readonly MAX_LENGTH = 100;

  private constructor(props: SymptomProps) {
    super(props);
  }

  static fromString(raw: string): Symptom {
    const normalized = raw.trim().toLowerCase();
    
    if (normalized.length === 0) {
      throw new DomainInvariantViolationError(
        'SYMPTOM_EMPTY',
        'Symptom cannot be empty',
        { metadata: { raw } }
      );
    }

    if (normalized.length > Symptom.MAX_LENGTH) {
      throw new DomainInvariantViolationError(
        'SYMPTOM_TOO_LONG',
        `Symptom must be at most ${Symptom.MAX_LENGTH} characters`,
        { metadata: { raw, length: normalized.length } }
      );
    }

    return new Symptom({ value: normalized });
  }

  get value(): string {
    return this.props.value;
  }

  matches(regex: RegExp): boolean {
    return regex.test(this.props.value);
  }
}
