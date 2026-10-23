/**
 * Infrastructure adapter: Query Classification Verifier.
 *
 * Implements LLM shadow consensus for heuristic query classifications.
 * Uses an optional IChatCompletionModel when confidence is below 0.7.
 *
 * Verification strategy:
 * 1. Evaluate heuristic confidence based on pattern match strength
 * 2. If confidence ≥ threshold → return heuristic result (skip LLM)
 * 3. If confidence < threshold → call LLM for shadow verification
 * 4. Compare results: agree → boost confidence; disagree → use LLM result
 *
 *
 * Academic references:
 * - Query intent classification (Broder, 2002)
 * - RAPTOR multi-strategy retrieval (Sarthi et al., 2024)
 * - Microsoft GraphRAG query routing (2024)
 *
 * Layer: Infrastructure
 * @see src/domain/memory/IQueryClassificationVerifier.ts
 */

import type {
  IQueryClassificationVerifier,
  QueryVerificationInput,
  QueryClassificationResult,
  VerifiedQueryClassification,
} from '../../../domain/memory/IQueryClassificationVerifier';
import type { IChatCompletionModel } from '../../../domain/ai/IChatCompletionModel';

const LABELS: readonly VerifiedQueryClassification[] = ['structural', 'semantic', 'keyword', 'hybrid'];

/** Confidence threshold below which LLM verification would be triggered. */
const CONFIDENCE_THRESHOLD = 0.7;

/** Structural query patterns (weighted). */
const STRUCTURAL_PATTERNS: readonly { pattern: string; weight: number }[] = [
  { pattern: 'who calls', weight: 1.0 },
  { pattern: 'what calls', weight: 1.0 },
  { pattern: 'callers of', weight: 1.0 },
  { pattern: 'callees of', weight: 1.0 },
  { pattern: 'depends on', weight: 0.9 },
  { pattern: 'dependency', weight: 0.8 },
  { pattern: 'impact of', weight: 0.9 },
  { pattern: 'impact analysis', weight: 1.0 },
  { pattern: 'imports', weight: 0.8 },
  { pattern: 'extends', weight: 0.9 },
  { pattern: 'implements', weight: 0.9 },
  { pattern: 'inherits', weight: 0.9 },
  { pattern: 'hierarchy', weight: 0.8 },
  { pattern: 'upstream', weight: 0.9 },
  { pattern: 'downstream', weight: 0.9 },
  { pattern: 'blast radius', weight: 1.0 },
];

/** Semantic query patterns (weighted). */
const SEMANTIC_PATTERNS: readonly { pattern: string; weight: number }[] = [
  { pattern: 'similar to', weight: 1.0 },
  { pattern: 'like', weight: 0.6 },
  { pattern: 'related to', weight: 0.9 },
  { pattern: 'equivalent', weight: 0.9 },
  { pattern: 'meaning', weight: 0.8 },
  { pattern: 'purpose', weight: 0.8 },
  { pattern: 'what does', weight: 0.7 },
  { pattern: 'how does', weight: 0.7 },
  { pattern: 'explain', weight: 0.8 },
  { pattern: 'describe', weight: 0.8 },
  { pattern: 'why', weight: 0.7 },
  { pattern: 'concept', weight: 0.8 },
];

/**
 * Compute weighted confidence for a classification.
 * Higher score = more confident the heuristic is correct.
 */
function computeConfidence(query: string): {
  classification: VerifiedQueryClassification;
  confidence: number;
} {
  const lower = query.toLowerCase();

  let structuralScore = 0;
  let semanticScore = 0;

  for (const { pattern, weight } of STRUCTURAL_PATTERNS) {
    if (lower.includes(pattern)) {
      structuralScore += weight;
    }
  }

  for (const { pattern, weight } of SEMANTIC_PATTERNS) {
    if (lower.includes(pattern)) {
      semanticScore += weight;
    }
  }

  const totalScore = structuralScore + semanticScore;
  const trimmed = query.trim();
  const isSymbol = /^[A-Z][a-zA-Z0-9]+$/.test(trimmed) || /^[a-z]+[A-Z]/.test(trimmed);

  if (structuralScore > 0 && semanticScore > 0) {
    return {
      classification: 'hybrid',
      confidence: Math.min(1.0, totalScore / 2.0),
    };
  }

  if (structuralScore > 0) {
    return {
      classification: 'structural',
      confidence: Math.min(1.0, structuralScore / 1.5),
    };
  }

  if (semanticScore > 0) {
    return {
      classification: 'semantic',
      confidence: Math.min(1.0, semanticScore / 1.5),
    };
  }

  if (isSymbol) {
    return { classification: 'structural', confidence: 0.6 };
  }

  // No patterns matched — low confidence
  return { classification: 'keyword', confidence: 0.3 };
}

function parseLabel(text: string): VerifiedQueryClassification | undefined {
  const match = text.toLowerCase().match(/\b(structural|semantic|keyword|hybrid)\b/);
  const label = match?.[1];
  return LABELS.find((item) => item === label);
}

export class QueryClassificationVerifierAdapter implements IQueryClassificationVerifier {
  constructor(private readonly model?: IChatCompletionModel) {}

  async verify(input: QueryVerificationInput): Promise<QueryClassificationResult> {
    const start = performance.now();
    const { confidence } = computeConfidence(input.query);
    const heuristicOnly = (): QueryClassificationResult => ({
      classification: input.heuristicResult,
      confidence,
      source: 'heuristic',
      heuristicClassification: input.heuristicResult,
      llmAgreed: null,
      durationMs: Math.round(performance.now() - start),
    });

    if ((confidence >= CONFIDENCE_THRESHOLD && !input.forceVerification) || !this.model) {
      return heuristicOnly();
    }

    try {
      const completion = await this.model.complete(
        [
          {
            role: 'system',
            content: 'Classify the code search query. Reply with one word: structural, semantic, keyword, or hybrid.',
          },
          { role: 'user', content: input.query },
        ],
        { maxOutputTokens: 8, correlationId: input.correlationId },
      );
      const label = parseLabel(completion.message.content);
      if (!label) {
        return heuristicOnly();
      }
      const llmAgreed = label === input.heuristicResult;
      return {
        classification: llmAgreed ? input.heuristicResult : label,
        confidence: llmAgreed ? Math.min(1, confidence + 0.15) : Math.max(confidence, 0.5),
        source: 'llm',
        heuristicClassification: input.heuristicResult,
        llmAgreed,
        durationMs: Math.round(performance.now() - start),
      };
    } catch {
      return heuristicOnly();
    }
  }
}
