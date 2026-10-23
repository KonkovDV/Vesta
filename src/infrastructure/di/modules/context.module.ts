/**
 * Context & Compaction DI Module
 * Registers services for Token Management, Summarization, and Context Compaction.
 * Layer: Infrastructure/DI
 */
import { container } from '../../../core/di/container';
import { SINGULARITY_TOKENS } from '../../../core/singularity/tokens';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { GptTokenizerAdapter } from '../../ai/gpt-tokenizer-adapter';
import { TokenBudgetManager } from '../../context/token-budget-manager';
import { RecursiveSummarizer } from '../../context/recursive-summarizer';
import { ContextCompactor } from '../../context/context-compactor';
import { RerankerAdapter } from '../../context/reranker-adapter';
import { RetrievalEvaluatorAdapter } from '../../context/retrieval-evaluator-adapter';
import { PromptCompressorAdapter } from '../../context/prompt-compressor-adapter';
import { IAIClient } from '../../../domain/ai/IAIClient';

export function registerContextServices(): void {
  try {
    // 1. Tokenizer (Layer 1)
    container.register(
      SINGULARITY_TOKENS.GPT_TOKENIZER,
      () => new GptTokenizerAdapter(),
      {
        lifecycle: 'singleton',
        tags: ['context', 'tokenizer', 'gpt'],
        description: 'GPT-Tokenizer adapter for accurate token counting'
      }
    );

    // 2. Token Budget Manager (Layer 2)
    container.register(
      SINGULARITY_TOKENS.TOKEN_BUDGET_MANAGER,
      (c) => new TokenBudgetManager(
        c.resolve(SINGULARITY_TOKENS.GPT_TOKENIZER)
      ),
      {
        lifecycle: 'singleton',
        tags: ['context', 'budget', 'manager'],
        description: 'Token Budget Manager for calculating model limits and usage'
      }
    );

    // 3. Summarizer (Layer 3)
    container.register(
      SINGULARITY_TOKENS.RECURSIVE_SUMMARIZER,
      (c) => new RecursiveSummarizer(
        c.resolve<IAIClient>(DI_TOKENS.IAIClient),
        c.resolve(SINGULARITY_TOKENS.GPT_TOKENIZER)
      ),
      {
        lifecycle: 'singleton',
        tags: ['context', 'summarizer', 'recursive'],
        description: 'Recursive Summarizer using AI Client'
      }
    );

    // 4. Context Compactor (Layer 4)
    container.register(
      SINGULARITY_TOKENS.CONTEXT_COMPACTOR,
      (c) => new ContextCompactor(
        c.resolve(SINGULARITY_TOKENS.TOKEN_BUDGET_MANAGER),
        c.resolve(SINGULARITY_TOKENS.RECURSIVE_SUMMARIZER)
      ),
      {
        lifecycle: 'singleton',
        tags: ['context', 'compactor', 'smart'],
        description: 'Context Compactor implementing Summarize-And-Forget strategy'
      }
    );

    console.log('✓ Context services registered');

    // ─── SOTA 2026 Context Engineering Services ────────────────────

    // 5. Reranker (ColBERTv2 — arXiv:2112.01488)
    if (!container.isRegistered(DI_TOKENS.IRerankerService)) {
      container.register(
        DI_TOKENS.IRerankerService,
        () => new RerankerAdapter(),
        {
          lifecycle: 'singleton',
          tags: ['context', 'sota-2026', 'reranker'],
          description: 'Semantic reranker (ColBERTv2 pattern, TF-IDF stub)',
        },
      );
    }

    // 6. Retrieval Evaluator (CRAG — arXiv:2401.15884)
    if (!container.isRegistered(DI_TOKENS.IRetrievalEvaluator)) {
      container.register(
        DI_TOKENS.IRetrievalEvaluator,
        () => new RetrievalEvaluatorAdapter(),
        {
          lifecycle: 'singleton',
          tags: ['context', 'sota-2026', 'crag'],
          description: 'CRAG-style retrieval quality evaluator (heuristic stub)',
        },
      );
    }

    // 7. Prompt Compressor (LongLLMLingua — arXiv:2310.06839)
    if (!container.isRegistered(DI_TOKENS.IPromptCompressor)) {
      container.register(
        DI_TOKENS.IPromptCompressor,
        () => new PromptCompressorAdapter(),
        {
          lifecycle: 'singleton',
          tags: ['context', 'sota-2026', 'compression'],
          description: 'LongLLMLingua-style prompt compression (heuristic stub)',
        },
      );
    }

    console.log('✓ SOTA 2026 context engineering services registered');
  } catch (error) {
    console.error('✗ Failed to register context services:', error);
    throw error;
  }
}
