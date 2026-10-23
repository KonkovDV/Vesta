import { ValueObject } from '../../../core/domain/ValueObject';
import { DomainInvariantViolationError } from '../../errors/DomainError';

/**
 * Reference to a DICOM Imaging Study (PS3.3 IOD, ISO 12052:2022).
 *
 * Immutable value object carrying only metadata needed for CDS workflow.
 * Actual pixel data / DICOM files are NOT stored in the domain model.
 *
 * Invariants:
 * - studyInstanceUid must be valid DICOM UID (PS3.5 §9.1)
 * - modality and bodyPartExamined must be non-empty
 * - seriesCount/instanceCount ≥ 0
 */

interface ImagingStudyRefProps {
  readonly studyInstanceUid: string;
  readonly modality: string;
  readonly bodyPartExamined: string;
  readonly studyDate: Date;
  readonly seriesCount: number;
  readonly instanceCount: number;
  readonly accessionNumber?: string;
  readonly referringPhysician?: string;
}

const DICOM_UID_PATTERN = /^[0-9]+(\.[0-9]+)*$/;
const MAX_UID_LENGTH = 64;

export class ImagingStudyRef extends ValueObject<ImagingStudyRefProps> {
  private constructor(props: ImagingStudyRefProps) {
    super(props);
  }

  static create(props: {
    studyInstanceUid: string;
    modality: string;
    bodyPartExamined: string;
    studyDate: Date;
    seriesCount: number;
    instanceCount: number;
    accessionNumber?: string;
    referringPhysician?: string;
  }): ImagingStudyRef {
    if (!DICOM_UID_PATTERN.test(props.studyInstanceUid) || props.studyInstanceUid.length > MAX_UID_LENGTH) {
      throw new DomainInvariantViolationError(
        'IMAGING_STUDY_INVALID_UID',
        'Study Instance UID must be a valid DICOM UID (PS3.5 §9.1, max 64 chars)',
        { metadata: { uid: props.studyInstanceUid } }
      );
    }

    if (props.modality.trim().length === 0) {
      throw new DomainInvariantViolationError(
        'IMAGING_STUDY_EMPTY_MODALITY',
        'Modality must be non-empty (e.g. MR, CT, US)',
        {}
      );
    }

    if (props.bodyPartExamined.trim().length === 0) {
      throw new DomainInvariantViolationError(
        'IMAGING_STUDY_EMPTY_BODY_PART',
        'Body part examined must be non-empty',
        {}
      );
    }

    if (props.seriesCount < 0 || props.instanceCount < 0) {
      throw new DomainInvariantViolationError(
        'IMAGING_STUDY_NEGATIVE_COUNT',
        'Series count and instance count must be non-negative',
        { metadata: { seriesCount: props.seriesCount, instanceCount: props.instanceCount } }
      );
    }

    return new ImagingStudyRef({
      studyInstanceUid: props.studyInstanceUid,
      modality: props.modality.trim(),
      bodyPartExamined: props.bodyPartExamined.trim(),
      studyDate: props.studyDate,
      seriesCount: props.seriesCount,
      instanceCount: props.instanceCount,
      accessionNumber: props.accessionNumber?.trim(),
      referringPhysician: props.referringPhysician?.trim(),
    });
  }

  get studyInstanceUid(): string { return this.props.studyInstanceUid; }
  get modality(): string { return this.props.modality; }
  get bodyPartExamined(): string { return this.props.bodyPartExamined; }
  get studyDate(): Date { return this.props.studyDate; }
  get seriesCount(): number { return this.props.seriesCount; }
  get instanceCount(): number { return this.props.instanceCount; }
  get accessionNumber(): string | undefined { return this.props.accessionNumber; }
  get referringPhysician(): string | undefined { return this.props.referringPhysician; }
}
