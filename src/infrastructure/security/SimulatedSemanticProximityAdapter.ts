/**
 * SimulatedSemanticProximityAdapter — Simulated vector similarity for development/testing.
 *
 * @layer Infrastructure (Security)
 * @pattern CC-029+ Semantic Proximity Provider (PUA v5.3)
 * @see src/domain/security/ISemanticProximityProvider.ts — domain port
 * @sota-stub No real embedding model wired — production requires S-MMU Tier 3
 */

import type {
  ISemanticProximityProvider,
  SemanticSimilarityResult,
  BatchSimilarityResult,
} from '../../domain/security/ISemanticProximityProvider';

// ── Logger ────────────────────────────────────────────────────────

interface ProximityLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

// ── Adapter ───────────────────────────────────────────────────────

/** @sota-stub Simulated similarity via path heuristic — production: S-MMU Tier 3 embeddings */
export class SimulatedSemanticProximityAdapter implements ISemanticProximityProvider {
  constructor(private readonly logger?: ProximityLogger) {
    this.logger?.info('SimulatedSemanticProximityAdapter initialized (path-heuristic mode)');
  }

  /** @sota-stub Computes similarity from shared path segments — production: cosine similarity */
  async getSimilarity(fileA: string, fileB: string): Promise<SemanticSimilarityResult> {
    const a = fileA.replace(/\\/g, '/');
    const b = fileB.replace(/\\/g, '/');

    const segmentsA = a.split('/');
    const segmentsB = b.split('/');

    // Jaccard-like similarity on path segments
    const setA = new Set(segmentsA);
    const setB = new Set(segmentsB);
    const intersection = [...setA].filter(s => setB.has(s)).length;
    const union = new Set([...setA, ...setB]).size;
    const similarity = union > 0 ? intersection / union : 0;

    return {
      fileA: a,
      fileB: b,
      similarity: Math.round(similarity * 1000) / 1000,
      embeddingsAvailable: false,
      computedAt: new Date().toISOString(),
    };
  }

  /** @sota-stub Batch path-heuristic similarity — production: vectorized batch */
  async getBatchSimilarity(
    sourceFile: string,
    targetFiles: readonly string[],
  ): Promise<BatchSimilarityResult> {
    const results: SemanticSimilarityResult[] = [];
    for (const target of targetFiles) {
      results.push(await this.getSimilarity(sourceFile, target));
    }

    return {
      results,
      embeddingsCoverage: 0,
      totalQueried: targetFiles.length,
    };
  }

  hasEmbedding(_filePath: string): boolean {
    return false; // Simulated — no real embeddings
  }
}
