/**
 * ILlmTestHarness — Domain port for deterministic LLM response mocking/replay.
 *
 * CC-018 LLM Test Harness: intercepts LLM adapter calls, stores prompt-response
 * pairs, and replays them deterministically for integration testing. Enables
 * agent test suites to run without live LLM calls, reducing cost and ensuring
 * reproducibility. Based on the LLM mocking pattern from OpenHands
 * (Wang et al. 2024, arXiv:2407.16741, Appendix E "Quality Control:
 * Integration Tests for Agents").
 *
 * Sub-capabilities:
 *   1. Response Recording — capture LLM prompt→response pairs during live runs
 *   2. Deterministic Replay — return stored responses on exact prompt match
 *   3. Fuzzy Matching — configurable similarity threshold for prompt matching
 *   4. Cassette Management — save/load prompt-response cassettes per test scenario
 *   5. Miss Tracking — log unmatched prompts for cassette regeneration
 *
 * @extraction V8.0 Knowledge Pipeline — Source: OpenHands (ICLR 2025)
 * @see PLANS/EXTRACTION/EXTRACTION_SYSTEM.md — Phase 2K Delta Classification
 */

export type HarnessMode = 'record' | 'replay' | 'passthrough';

export interface PromptResponsePair {
  readonly pairId: string;
  readonly promptHash: string;
  readonly promptText: string;
  readonly modelId: string;
  readonly response: string;
  readonly recordedAt: string;
  readonly latencyMs: number;
  readonly tokenUsage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  };
}

export interface TestCassette {
  readonly cassetteId: string;
  readonly name: string;
  readonly description?: string;
  readonly pairs: readonly PromptResponsePair[];
  readonly createdAt: string;
  readonly modelId: string;
  readonly version: number;
}

export interface ReplayResult {
  readonly matched: boolean;
  readonly response?: string;
  readonly pairId?: string;
  readonly similarityScore?: number;
}

export interface HarnessMiss {
  readonly promptHash: string;
  readonly promptText: string;
  readonly modelId: string;
  readonly timestamp: string;
  readonly closestMatchScore: number;
  readonly closestMatchPairId?: string;
}

export interface HarnessStats {
  readonly totalRequests: number;
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly mode: HarnessMode;
  readonly activeCassetteId?: string;
}

/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface ILlmTestHarness {
  /**
   * Set the harness mode: record (capture live), replay (use stored), or passthrough (disabled).
   */
  setMode(mode: HarnessMode): void;

  /**
   * Get the current harness mode.
   */
  getMode(): HarnessMode;

  /**
   * Load a cassette for replay.
   */
  loadCassette(cassette: TestCassette): void;

  /**
   * Record a prompt-response pair (used in record mode).
   */
  recordPair(promptText: string, modelId: string, response: string, latencyMs: number, tokenUsage: { promptTokens: number; completionTokens: number }): PromptResponsePair;

  /**
   * Attempt to replay a stored response for the given prompt.
   * Returns match result with optional fuzzy similarity score.
   */
  replay(promptText: string, modelId: string, similarityThreshold?: number): ReplayResult;

  /**
   * Export all recorded pairs as a cassette.
   */
  exportCassette(name: string, description?: string): TestCassette;

  /**
   * Get all unmatched prompts (misses) from replay mode.
   */
  getMisses(): readonly HarnessMiss[];

  /**
   * Get current harness statistics.
   */
  getStats(): HarnessStats;

  /**
   * Reset the harness state (clear recorded pairs, misses, and stats).
   */
  reset(): void;
}
