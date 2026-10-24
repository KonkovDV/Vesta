/**
 * Reading the journal in commit order, and remembering where a consumer stopped.
 *
 * A gsn is drawn at INSERT and becomes visible at COMMIT, so a consumer that keeps
 * "last gsn" skips an event whose transaction drew a lower gsn and committed later
 * (MP-K23). A commit-order reader never returns a row past a transaction that may
 * still commit, and its cursor names the writing transaction as well as the gsn.
 */
import type { DomainEvent } from './event-store.interface';

/** Position in commit order: the writing transaction and the event's gsn inside it. */
export interface CommitCursor {
  txId: string;
  gsn: number;
}

export interface CommittedEventsPage {
  events: Array<DomainEvent & { gsn?: number }>;
  /** Cursor after the last returned event, or the cursor passed in when there were none. */
  cursor: CommitCursor | null;
}

export interface ICommitOrderReader {
  getCommittedEventsAfter(cursor: CommitCursor | null, limit?: number): Promise<CommittedEventsPage>;
}

/**
 * Durable consumer positions. `saveConsumerCursor` only moves a cursor forward, so a
 * slow consumer that finishes after a faster one cannot move it back.
 */
export interface IConsumerCursorStore {
  loadConsumerCursor(consumer: string): Promise<CommitCursor | null>;
  saveConsumerCursor(consumer: string, cursor: CommitCursor): Promise<void>;
}

export function isCommitOrderReader(value: unknown): value is ICommitOrderReader {
  return typeof (value as Partial<ICommitOrderReader> | null)?.getCommittedEventsAfter === 'function';
}

export function isConsumerCursorStore(value: unknown): value is IConsumerCursorStore {
  const candidate = value as Partial<IConsumerCursorStore> | null;
  return typeof candidate?.loadConsumerCursor === 'function'
    && typeof candidate?.saveConsumerCursor === 'function';
}
