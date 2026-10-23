import { EntityId } from '../../core/types';

export class ResearchReportId extends EntityId {
  private constructor(value: string) {
    super(value);
  }

  static create(): ResearchReportId {
    const base = EntityId.random();
    return new ResearchReportId(base.value);
  }

  static fromString(value: string): ResearchReportId {
    const base = EntityId.fromString(value);
    return new ResearchReportId(base.value);
  }

  toValue(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export class ResearcherId extends EntityId {
  private constructor(value: string) {
    super(value);
  }

  static fromString(value: string): ResearcherId {
    const base = EntityId.fromString(value);
    return new ResearcherId(base.value);
  }

  toValue(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}