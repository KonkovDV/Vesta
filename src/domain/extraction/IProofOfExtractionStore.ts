/**
 * IProofOfExtractionStore — Domain port for Proof-of-Extraction (PoE).
 *
 * Layer: Domain
 *
 * Binds extraction pipeline events to the IEventStore, enabling immutable
 * cryptographic provenance for every module extracted by the V5 pipeline.
 *
 * Each MCP tool execution (donor_recon, donor_scan, donor_score, donor_generate_spec,
 * donor_verify_extraction) emits a signed ExtractionEvent into the Event Store.
 * ISingularityCoreAuditor can later trace the provenance of any AST node back
 * to the exact extraction phase that produced it.
 *
 * Horizon 5 alignment: Proof-of-Extraction is a prerequisite for Algorithmic
 * Governance — code provenance must be cryptographically verifiable.
 *
 * @see PLANS/EXTRACTION/EXTRACTION_SYSTEM.md — V13.0 Pipeline specification
 * @see PLANS/DOCS_AUDIT_2026/71_EXTRACTION_V5_SOTA_AUDIT_MARCH_2026.md §2.2
 * @see src/domain/security/pq-crypto.interface.ts — IPqcCryptoProvider
 */

import type { CorrelationId } from '../../core/context/IRequestContext';

// ── Extraction Phase Enum ───────────────────────────────────────────

/** V5 Pipeline phases (0–8 + 2.5 RE-VERIFY) */
export type ExtractionPhase =
  | 'RECON'        // Phase 0
  | 'DIG'          // Phase 1
  | 'SCAN'         // Phase 2
  | 'RE_VERIFY'    // Phase 2.5
  | 'SCORE'        // Phase 3
  | 'SPEC'         // Phase 4
  | 'ADAPT'        // Phase 5
  | 'TEST'         // Phase 6
  | 'AUDIT'        // Phase 7
  | 'DOC';         // Phase 8

/** Extraction tier classification (V5 §1.2) */
export type ExtractionTier = 0 | 1 | 2 | 3 | 4;

// ── Event Payloads ──────────────────────────────────────────────────

/**
 * Payload for an extraction event emitted by the MCP Extraction Server.
 */
export interface ExtractionEventPayload {
  /** V5 pipeline phase that produced this event */
  readonly phase: ExtractionPhase;
  /** Donor project name (e.g., 'mastra', 'openclaw') */
  readonly donorName: string;
  /** Source file path relative to donor root */
  readonly sourceFile: string;
  /** Extraction tier (0-4) */
  readonly tier: ExtractionTier;
  /** FITNESS score (0-100), present after SCORE phase */
  readonly fitnessScore?: number;
  /** MCP tool name that produced this event */
  readonly mcpToolName: string;
  /** Duration of the tool execution in milliseconds */
  readonly durationMs: number;
  /** OWASP ASI identifier if applicable */
  readonly owaspAsi?: string;
  /** Target path in MicroPhoenix after adaptation */
  readonly targetPath?: string;
  /** Whether the extraction was successful */
  readonly success: boolean;
  /** Error message if extraction failed */
  readonly errorMessage?: string;
}

/**
 * Result of recording a proof-of-extraction event.
 */
export interface ProofOfExtractionResult {
  /** Event ID assigned by the Event Store */
  readonly eventId: string;
  /** Whether PQC signature was attached */
  readonly pqcSigned: boolean;
  /** Verification method used (or 'none') */
  readonly verificationMethod: string;
}

// ── Domain Port ─────────────────────────────────────────────────────

/**
 * Domain port for immutable Proof-of-Extraction recording.
 *
 * Infrastructure layer implements this by:
 * 1. Creating a DomainEvent from the ExtractionEventPayload
 * 2. Optionally signing it via IPqcCryptoProvider (Horizon 3)
 * 3. Persisting it to IEventStore (Outbox-first)
 *
 * This ensures every extraction is cryptographically traceable.
 */
export interface IProofOfExtractionStore {
  /**
   * Record a proof-of-extraction event for a pipeline phase.
   *
   * @param payload — extraction event data
   * @param correlationId — tracing ID for the extraction sprint
   * @returns proof result with event ID and signature status
   */
  recordExtraction(
    payload: ExtractionEventPayload,
    correlationId: CorrelationId,
  ): Promise<ProofOfExtractionResult>;

  /**
   * Retrieve all extraction events for a donor project.
   *
   * @param donorName — donor project name
   * @param correlationId — tracing ID
   * @returns array of extraction event payloads in chronological order
   */
  getExtractionHistory(
    donorName: string,
    correlationId: CorrelationId,
  ): Promise<readonly ExtractionEventPayload[]>;

  /**
   * Verify the integrity of a specific extraction event.
   * Returns true if the PQC signature (if present) is valid.
   *
   * @param eventId — the event ID to verify
   * @param correlationId — tracing ID
   * @returns true if the event is intact and signature is valid
   */
  verifyExtraction(
    eventId: string,
    correlationId: CorrelationId,
  ): Promise<boolean>;
}
