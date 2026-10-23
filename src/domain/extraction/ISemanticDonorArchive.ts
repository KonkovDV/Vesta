/**
 * ISemanticDonorArchive — Domain port for Semantic Donor Archiving.
 *
 * Layer: Domain
 *
 * When a donor repository is offboarded (deleted from external/), the skipped
 * and too-coupled code is not simply discarded. Instead, it is compressed into
 * semantic embeddings and AST structure graphs, then stored in the Hybrid
 * Semantic Graph (HSG) for long-term retrieval.
 *
 * This enables "Zero-Day Extraction" — future agents can reconstruct skipped
 * algorithms from the Semantic Archive without re-cloning the legacy donor.
 *
 * Horizon 4 alignment: Personalized JIT Knowledge — donors become genetic
 * material for the HSG, providing architectural memory across generations.
 *
 * @see PLANS/DOCS_AUDIT_2026/71_EXTRACTION_V5_SOTA_AUDIT_MARCH_2026.md §2.1
 * @see PLANS/EXTRACTION/EXTRACTION_SYSTEM.md — V13.0 Pipeline specification
 */

import type { CorrelationId } from '../../core/context/IRequestContext';

// ── Archived File Entry ─────────────────────────────────────────────

/**
 * Metadata for a single archived donor file.
 */
export interface ArchivedDonorFile {
  /** Original file path relative to donor root */
  readonly sourcePath: string;
  /** Scan classification category (SKIP, TOO_COUPLED, DEPRECATED, etc.) */
  readonly classification: string;
  /** Reason the file was not extracted */
  readonly skipReason: string;
  /** Number of lines in the original file */
  readonly lineCount: number;
  /** Size in bytes */
  readonly sizeBytes: number;
  /** Extracted public API signatures (function/class names) */
  readonly publicApi: readonly string[];
  /** Internal dependency count */
  readonly internalDeps: number;
  /** External npm dependencies */
  readonly externalDeps: readonly string[];
}

/**
 * Result of archiving a donor's skipped code.
 */
export interface SemanticArchiveResult {
  /** Donor project name */
  readonly donorName: string;
  /** Number of files archived */
  readonly archivedCount: number;
  /** Number of files that failed to archive */
  readonly failedCount: number;
  /** Total tokens consumed by the archive */
  readonly totalTokens: number;
  /** Archive timestamp (ISO 8601) */
  readonly archivedAt: string;
}

/**
 * Query parameters for searching the semantic archive.
 */
export interface SemanticArchiveQuery {
  /** Natural language query describing the desired algorithm/pattern */
  readonly query: string;
  /** Maximum results to return (default: 10) */
  readonly limit?: number;
  /** Filter by original donor name */
  readonly donorName?: string;
  /** Filter by skip reason */
  readonly skipReason?: string;
}

/**
 * A search result from the semantic archive.
 */
export interface SemanticArchiveMatch {
  /** Original donor name */
  readonly donorName: string;
  /** Original file path */
  readonly sourcePath: string;
  /** Relevance score (0-1) */
  readonly relevance: number;
  /** Public API from the skipped file */
  readonly publicApi: readonly string[];
  /** Skip reason */
  readonly skipReason: string;
  /** Extracted architectural insights */
  readonly architecturalNotes: string;
}

// ── Domain Port ─────────────────────────────────────────────────────

/**
 * Domain port for Semantic Donor Archiving.
 *
 * Infrastructure layer implements this by:
 * 1. Scanning donor files classified as SKIP/TOO_COUPLED/DEPRECATED
 * 2. Extracting public API signatures and AST structure
 * 3. (Future) Generating vector embeddings via IEmbeddingProvider
 * 4. Storing compressed metadata in the HSG
 */
export interface ISemanticDonorArchive {
  /**
   * Archive all skipped/not-extracted files from a donor before offboarding.
   *
   * @param donorPath — absolute path to the donor directory
   * @param donorName — donor project name
   * @param skippedFiles — list of files classified as non-extractable
   * @param correlationId — tracing ID
   * @returns archive result with counts and token usage
   */
  archiveDonor(
    donorPath: string,
    donorName: string,
    skippedFiles: readonly ArchivedDonorFile[],
    correlationId: CorrelationId,
  ): Promise<SemanticArchiveResult>;

  /**
   * Search the semantic archive for algorithms matching a natural language query.
   *
   * @param query — search parameters
   * @param correlationId — tracing ID
   * @returns matching archived entries ranked by relevance
   */
  searchArchive(
    query: SemanticArchiveQuery,
    correlationId: CorrelationId,
  ): Promise<readonly SemanticArchiveMatch[]>;

  /**
   * Check whether a donor has been semantically archived.
   *
   * @param donorName — donor project name
   * @param correlationId — tracing ID
   * @returns true if the donor has archived entries
   */
  isDonorArchived(
    donorName: string,
    correlationId: CorrelationId,
  ): Promise<boolean>;
}
