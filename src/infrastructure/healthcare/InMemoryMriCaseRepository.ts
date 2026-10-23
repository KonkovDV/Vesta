import { IMriSecondOpinionCaseRepository } from '../../domain/healthcare/ports/IMriSecondOpinionCaseRepository';
import { MriSecondOpinionCase } from '../../domain/healthcare/aggregates/MriSecondOpinionCase';

/**
 * In-memory implementation of IMriSecondOpinionCaseRepository.
 *
 * Used for unit testing and local development.
 * Production persistence will use PostgreSQL + IEventStore (Outbox-first).
 *
 * @layer Infrastructure
 */
export class InMemoryMriCaseRepository implements IMriSecondOpinionCaseRepository {
  private readonly store = new Map<string, MriSecondOpinionCase>();

  async save(mriCase: MriSecondOpinionCase): Promise<void> {
    this.store.set(mriCase.id.toString(), mriCase);
  }

  async findById(id: string): Promise<MriSecondOpinionCase | null> {
    return this.store.get(id) ?? null;
  }

  async findByStudyUid(studyInstanceUid: string): Promise<MriSecondOpinionCase[]> {
    const results: MriSecondOpinionCase[] = [];
    for (const mriCase of this.store.values()) {
      if (mriCase.study.studyInstanceUid === studyInstanceUid) {
        results.push(mriCase);
      }
    }
    return results;
  }

  /** Test helper: clear all stored cases */
  clear(): void {
    this.store.clear();
  }

  /** Test helper: get stored case count */
  get size(): number {
    return this.store.size;
  }
}
