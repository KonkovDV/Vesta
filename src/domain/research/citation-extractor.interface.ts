/**
 * Citation Extractor — Domain Interface (Port)
 *
 * Extracts and annotates citations from text referencing sources.
 * Given a text body and a list of sources, identifies which parts
 * of the text cite which sources.
 *
 * @see Book Ch.6 — Citation Annotation Extractor
 * @see Gulli, "Agentic Design Patterns" (Springer 2026)
 */
import type { CorrelationId } from '@/core/types/branded';
import type { Citation, ResearchSource } from './deep-research.interface';

export interface ICitationExtractor {
  /**
   * Extract citations from text body that reference the given sources.
   * Returns citations with source indices for provenance tracking.
   */
  extract(
    text: string,
    sources: readonly ResearchSource[],
    correlationId: CorrelationId,
  ): Promise<readonly Citation[]>;
}
