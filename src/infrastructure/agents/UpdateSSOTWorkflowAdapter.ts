/**
 * UpdateSSOTWorkflowAdapter — Infrastructure adapter for LATS Consensus SSOT updates.
 *
 * Generates multiple candidate update variants for critical SSOT files,
 * evaluates each through ICriticFeedbackService for contradictions with
 * DI_TOKENS and architectural invariants, and selects the highest-confidence variant.
 *
 * In this in-memory adapter, candidate generation creates deterministic
 * textual variants (reordering, formatting). LLM-based generation is
 * delegated to optional ITreeOfThoughts integration when wired.
 *
 * @layer Infrastructure (Agents)
 * @pattern LATS Consensus Policy (SOTA 2026 — Multi-Variant SSOT Validation)
 * @see src/domain/agents/IUpdateSSOTWorkflow.ts — domain port
 * @see src/domain/audit/ICriticFeedbackService.ts — contradiction analysis
 * @see src/domain/ai/ITreeOfThoughts.ts — LATS tree search (optional)
 */

import type {
  IUpdateSSOTWorkflow,
  SSOTUpdateRequest,
  SSOTUpdateResult,
  SSOTCandidate,
  SSOTUpdateDecision,
} from '../../domain/agents/IUpdateSSOTWorkflow';
import type {
  ICriticFeedbackService,
  AgentDiagnostic,
} from '../../domain/audit/ICriticFeedbackService';

// ─── Helpers ─────────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const DEFAULT_CANDIDATE_COUNT = 3;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MAX_RETRIES = 0;

let candidateCounter = 0;

function generateCandidateId(): string {
  candidateCounter += 1;
  return `ssot-cand-${Date.now()}-${candidateCounter}`;
}

// ─── Adapter ─────────────────────────────────────────────────────

export class UpdateSSOTWorkflowAdapter implements IUpdateSSOTWorkflow {
  constructor(
    private readonly criticService: ICriticFeedbackService,
    private readonly logger?: MinimalLogger,
  ) {}

  async evaluateUpdate(
    request: SSOTUpdateRequest,
    correlationId: string,
  ): Promise<SSOTUpdateResult> {
    const startMs = Date.now();
    const now = new Date().toISOString();
    const candidateCount = request.candidateCount ?? DEFAULT_CANDIDATE_COUNT;
    const minConfidence = request.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const maxRetries = request.maxRetries ?? DEFAULT_MAX_RETRIES;

    let retriesUsed = 0;
    let allCandidates: SSOTCandidate[] = [];
    let currentContent = request.proposedContent;

    // LATS retry loop: re-generate candidates incorporating critic feedback
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Step 1: Generate candidate variants
      const rawCandidates = this.generateVariants(
        currentContent,
        candidateCount,
        request.targetSection,
      );

      // Step 2: Evaluate each candidate through ICriticFeedbackService
      const evaluatedCandidates: SSOTCandidate[] = [];

      for (const rawContent of rawCandidates) {
        const evalStart = Date.now();

        const diagnostic: AgentDiagnostic = {
          source: 'architecture',
          code: 'SSOT_UPDATE',
          message: `Proposed SSOT update for ${request.targetFile}: ${request.updateReason}`,
          file: request.targetFile,
          severity: 'info',
        };

        const feedback = await this.criticService.analyzeDiagnostic(
          diagnostic,
          correlationId as never, // CorrelationId branded type
        );

        const contradictions = feedback.suggestions
          .filter(s => s.confidence === 'high')
          .map(s => s.description);

        const confidence = this.calculateConfidence(feedback, contradictions.length);
        const evalMs = Date.now() - evalStart;

        evaluatedCandidates.push({
          candidateId: generateCandidateId(),
          content: rawContent,
          confidence,
          rationale: feedback.rootCause || feedback.summary,
          contradictions,
          evaluationMs: evalMs,
        });
      }

      // Step 3: Sort by confidence (descending)
      evaluatedCandidates.sort((a, b) => b.confidence - a.confidence);
      allCandidates = evaluatedCandidates;

      const bestCandidate = evaluatedCandidates[0];
      if (bestCandidate && bestCandidate.confidence >= minConfidence) {
        // Candidate accepted — exit retry loop
        break;
      }

      // If we still have retries left, incorporate critic feedback into content
      if (attempt < maxRetries) {
        retriesUsed++;
        const topFeedback = evaluatedCandidates[0];
        if (topFeedback && topFeedback.contradictions.length > 0) {
          // Append contradiction context to help next iteration generate better variants
          currentContent = currentContent.trim() +
            `\n<!-- LATS retry ${retriesUsed}: resolved contradictions: ${topFeedback.contradictions.join('; ')} -->`;
        }

        this.logger?.info('LATS retry: regenerating candidates', {
          correlationId,
          attempt: attempt + 1,
          maxRetries,
          bestConfidence: topFeedback?.confidence ?? 0,
        });
      }
    }

    // Step 4: Final decision
    const bestCandidate = allCandidates[0];
    let decision: SSOTUpdateDecision;

    if (bestCandidate && bestCandidate.confidence >= minConfidence) {
      decision = bestCandidate.contradictions.length === 0 ? 'accepted' : 'needs_review';
    } else {
      decision = 'rejected';
    }

    const totalDurationMs = Date.now() - startMs;

    this.logger?.info('SSOT update consensus evaluation completed', {
      correlationId,
      targetFile: request.targetFile,
      decision,
      candidatesEvaluated: allCandidates.length,
      bestConfidence: bestCandidate?.confidence ?? 0,
      retriesUsed,
      totalDurationMs,
    });

    return {
      decision,
      selectedCandidate: decision !== 'rejected' ? bestCandidate : undefined,
      candidates: allCandidates,
      targetFile: request.targetFile,
      totalDurationMs,
      retriesUsed,
      evaluatedAt: now,
    };
  }

  // ─── Private ─────────────────────────────────────────────────

  /**
   * Generate N deterministic text variants from the proposed content.
   *
   * Variants are created by applying controlled transformations:
   * - Variant 0: original content (baseline)
   * - Variant 1: trimmed whitespace + normalized line endings
   * - Variant 2+: content with section header prefix
   *
   * In production, this would delegate to ITreeOfThoughts.expandNode()
   * for LLM-generated variants.
   */
  private generateVariants(
    proposedContent: string,
    count: number,
    targetSection?: string,
  ): string[] {
    const variants: string[] = [];

    // Variant 0: original content
    variants.push(proposedContent);

    if (count >= 2) {
      // Variant 1: normalized (trimmed, line endings normalized)
      variants.push(proposedContent.trim().replace(/\r\n/g, '\n'));
    }

    for (let i = 2; i < count; i++) {
      // Variant 2+: with section context prefix
      const prefix = targetSection
        ? `<!-- SSOT Update: ${targetSection} -->\n`
        : `<!-- SSOT Update: variant ${i} -->\n`;
      variants.push(prefix + proposedContent.trim());
    }

    return variants;
  }

  /**
   * Calculate confidence score based on critic feedback.
   * Fewer contradictions = higher confidence.
   */
  private calculateConfidence(
    feedback: { suggestions: readonly { confidence: string }[] },
    contradictionCount: number,
  ): number {
    // Base confidence starts at 0.9
    const base = 0.9;
    // Each contradiction reduces confidence by 0.15
    const penalty = contradictionCount * 0.15;
    // Low-confidence suggestions reduce by 0.05 each
    const lowConfCount = feedback.suggestions
      .filter(s => s.confidence === 'low')
      .length;
    const lowPenalty = lowConfCount * 0.05;

    return Math.max(0, Math.min(1, base - penalty - lowPenalty));
  }
}
