/**
 * Prompt Chain Executor — Domain Interface (Port)
 *
 * Executes a sequence of prompt steps, piping output from one to next.
 * Supports conditional branching, per-step validation, model overrides.
 *
 * Best Practices Applied (March 2026):
 * - Atom of Thoughts (Teng et al., NeurIPS 2025): each step is self-contained,
 *   minimizing reliance on historical context — Markovian chain structure
 * - ADK conditional routing (Ch.2): steps can be conditionally skipped
 * - Template variable validation before chain execution
 * - Streaming progress callback (onStepComplete) for progressive UX
 *
 * @see Book Ch.1 "Building Blocks" — Prompt Chain Pipeline
 * @see Book Ch.2 "ADK" — Conditional Routing
 * @see Gulli, "Agentic Design Patterns" (Springer 2026)
 */
import type { CorrelationId } from '@/core/types/branded';

/**
 * Single step in a prompt chain.
 * Supports {{prev_output}} and {{input}} placeholders in prompts.
 */
export interface ChainStep {
  readonly name: string;
  readonly prompt: string;
  readonly outputKey: string;
  readonly templateVars?: readonly string[];
  readonly validator?: (output: string) => boolean;
  readonly condition?: (context: ChainContext) => boolean;
  readonly model?: string;
}

export interface ChainContext {
  readonly steps: Readonly<Record<string, string>>;
  readonly currentStep: number;
  readonly input: string;
}

export interface ChainResult {
  readonly steps: Readonly<Record<string, string>>;
  readonly finalOutput: string;
  readonly stepsExecuted: number;
  readonly skippedSteps: readonly string[];
  readonly totalTokens: { readonly input: number; readonly output: number };
  readonly durationMs: number;
}

export interface IPromptChainExecutor {
  /**
   * Execute a sequential chain of prompt steps.
   * Steps are piped: output of step N becomes input for step N+1.
   * Steps with condition=false are skipped.
   */
  executeChain(
    steps: readonly ChainStep[],
    input: string,
    correlationId: CorrelationId,
    onStepComplete?: (stepName: string, output: string) => void,
  ): Promise<ChainResult>;
}
