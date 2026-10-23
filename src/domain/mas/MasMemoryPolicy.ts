/**
 * MAS Durable Execution - memory persistence policy enum.
 *
 * Layer: Domain (MAS durable execution model).
 *
 * Describes how results of a durable execution step should be
 * written into MAS / Session / Long‑term memory subsystems.
 *
 * NOTE:
 * - This is a declarative hint for higher layers; the domain model
 *   itself does not talk to Memory directly.
 */
export enum MasMemoryPolicy {
  /**
   * Do not persist anything to memory for this step.
   */
  NONE = 'NONE',

  /**
   * Persist into short‑term/session memory only (ephemeral context).
   */
  SHORT_TERM = 'SHORT_TERM',

  /**
   * Persist into long‑term memory (e.g. user profile, knowledge base).
   */
  LONG_TERM = 'LONG_TERM',

  /**
   * Persist only a compact summary of the result, not full raw data.
   */
  SUMMARY_ONLY = 'SUMMARY_ONLY',
}