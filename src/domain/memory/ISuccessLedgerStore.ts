/**
 * ISuccessLedgerStore — Durable persistence port for PUA Success Ledger entries.
 *
 * Stores the operational evidence stream that feeds S2I lesson extraction.
 * This keeps recurrence counts, trajectory quality history, and promotion
 * context stable across process restarts.
 *
 * @layer Domain
 */

import type {
  RootCauseCategory,
  SuccessLedgerEntry,
} from '../agents/IS2iLessonExtractor';

export interface SuccessLedgerEntryFilter {
  /** Optional filter by root cause category. */
  readonly rootCauseCategory?: RootCauseCategory;
  /** Optional filter by session id. */
  readonly sessionId?: string;
}

export interface ISuccessLedgerStore {
  /** Persist a Success Ledger entry. */
  saveEntry(entry: SuccessLedgerEntry): Promise<void>;

  /** List stored Success Ledger entries, optionally filtered. */
  listEntries(filter?: SuccessLedgerEntryFilter): Promise<readonly SuccessLedgerEntry[]>;
}