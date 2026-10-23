/**
 * IPqcEventChain — Domain port for PQC event chain signing and verification.
 *
 * Provides cryptographic provenance for event streams: each event is signed
 * with a post-quantum digital signature (ML-DSA / SLH-DSA) and linked to
 * the previous event via `previousPQCHash`, forming a tamper-evident chain.
 *
 * @layer Domain
 * @pattern Pillar-4 PQC Provenance (Event Chain)
 * @FITNESS-K 94.0
 * @see NIST FIPS 204 — ML-DSA (Dilithium)
 * @see NIST FIPS 205 — SLH-DSA (SPHINCS+)
 * @see src/domain/security/pq-crypto.interface.ts — Low-level PQC crypto port
 */

import type { CorrelationId } from '../../core/types/branded';
import type { PqcKeyPair, PqcSignature, SignatureAlgorithm } from '../security/pq-crypto.interface';

// ── Signed Event Metadata ───────────────────────────────────────────

/**
 * PQC metadata attached to each event in a signed chain.
 * Contains the signature, chain link hash, and sequence number.
 */
export interface PqcSignedEventMetadata {
  /** PQC digital signature over the canonical event payload */
  readonly pqcSignature: PqcSignature;
  /** SHA-3-256 hex digest of the previous event's signed payload (genesis = '0'.repeat(64)) */
  readonly previousPQCHash: string;
  /** Monotonically increasing chain position (0-based) */
  readonly chainSequence: number;
  /** SHA-3-256 hex digest of this event's signed payload */
  readonly eventHash: string;
}

// ── Chain Verification ──────────────────────────────────────────────

/**
 * Result of verifying a chain of PQC-signed events.
 */
export interface ChainVerificationResult {
  /** Whether the entire chain is cryptographically valid */
  readonly valid: boolean;
  /** Number of events that passed verification */
  readonly verifiedCount: number;
  /** Total number of events in the chain */
  readonly totalCount: number;
  /** Chain sequence of the first broken link (undefined if valid) */
  readonly firstBrokenLink?: number;
  /** Human-readable error description (undefined if valid) */
  readonly error?: string;
}

// ── Port Interface ──────────────────────────────────────────────────

/**
 * PQC Event Chain — signs individual events and verifies chain integrity.
 *
 * The signing flow:
 * 1. Caller provides the event payload as canonical bytes
 * 2. `signEvent()` signs with the given key pair and links to the previous hash
 * 3. Returns metadata that must be stored alongside the event
 *
 * The verification flow:
 * 1. Caller provides an ordered sequence of (payload, metadata) pairs
 * 2. `verifyChain()` checks each signature and each chain link
 * 3. Returns a result indicating validity + first broken link
 */
export interface IPqcEventChain {
  /**
   * Sign a single event and produce chain metadata.
   *
   * @param eventPayload — canonical serialized event bytes
   * @param keyPair — PQC key pair for signing (ML-DSA or SLH-DSA)
   * @param algorithm — signature algorithm to use
   * @param previousHash — SHA-3-256 hex of the previous event (genesis: '0'.repeat(64))
   * @param chainSequence — position in the chain (0-based, monotonically increasing)
   * @param correlationId — tracing ID for structured logging
   * @returns signed event metadata with signature + chain link
   */
  signEvent(
    eventPayload: Uint8Array,
    keyPair: PqcKeyPair,
    algorithm: SignatureAlgorithm,
    previousHash: string,
    chainSequence: number,
    correlationId: CorrelationId,
  ): Promise<PqcSignedEventMetadata>;

  /**
   * Verify a chain of signed events for integrity and tamper-evidence.
   *
   * Checks:
   * (a) Each event's signature is valid
   * (b) Each event's previousPQCHash matches the prior event's eventHash
   * (c) Chain sequence is monotonically increasing
   *
   * @param events — ordered list of (payload, metadata) pairs
   * @param correlationId — tracing ID
   * @returns chain verification result
   */
  verifyChain(
    events: ReadonlyArray<{ readonly payload: Uint8Array; readonly metadata: PqcSignedEventMetadata }>,
    correlationId: CorrelationId,
  ): Promise<ChainVerificationResult>;

  /**
   * Compute the SHA-3-256 hash of an event payload.
   * Used to derive the chain link hash.
   *
   * @param eventPayload — canonical serialized event bytes
   * @returns hex-encoded SHA-3-256 digest
   */
  computeEventHash(eventPayload: Uint8Array): Promise<string>;
}
