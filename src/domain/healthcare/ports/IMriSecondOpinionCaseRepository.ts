import { MriSecondOpinionCase } from '../aggregates/MriSecondOpinionCase';

/**
 * Repository port for MRI Second Opinion Case aggregates.
 *
 * Follows the DDD Repository pattern: persistence-agnostic
 * interface defined in the Domain layer, with implementation
 * in Infrastructure.
 *
 * @layer Domain (port)
 * @see src/infrastructure/healthcare/ — adapter implementations
 */
export interface IMriSecondOpinionCaseRepository {
  /**
   * Save a new or updated MRI case aggregate.
   * Must persist uncommitted domain events via IEventStore (Outbox-first).
   */
  save(mriCase: MriSecondOpinionCase): Promise<void>;

  /**
   * Find a case by its aggregate ID.
   * Returns null if not found.
   */
  findById(id: string): Promise<MriSecondOpinionCase | null>;

  /**
   * Find all cases for a given study instance UID (DICOM PS3.3).
   * A single imaging study may have multiple second-opinion requests.
   */
  findByStudyUid(studyInstanceUid: string): Promise<MriSecondOpinionCase[]>;
}
