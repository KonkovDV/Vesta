/**
 * Tool Loop Detector — Domain port for detecting repetitive tool call loops
 * in agentic AI sessions.
 *
 * Implements 4 detection strategies:
 *  - Generic repeat: identical tool+params called repeatedly
 *  - Known poll no-progress: polling tools returning identical results
 *  - Ping-pong: alternating between two tool call patterns
 *  - Global circuit breaker: hard safety limit on any repetition
 *
 * @layer Domain (Agents)
 * @phase OpenClaw Extraction V4 — Sprint 2
 * @donor external/openclaw/src/agents/tool-loop-detection.ts (560L, 1 dep: node:crypto)
 * @owasp Agentic Top 10 2026: Resource Exhaustion, Infinite Loop DoS
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Kind of loop detector that triggered the result. */
export type LoopDetectorKind =
  | 'generic_repeat'
  | 'known_poll_no_progress'
  | 'global_circuit_breaker'
  | 'ping_pong';

/** Result of loop detection analysis. */
export type LoopDetectionResult =
  | { stuck: false }
  | {
    stuck: true;
    level: 'warning' | 'critical';
    detector: LoopDetectorKind;
    count: number;
    message: string;
    pairedToolName?: string;
    warningKey?: string;
  };

/** Configuration for the loop detection system. */
export interface ToolLoopDetectionConfig {
  /** Enable/disable loop detection (default: true). */
  readonly enabled?: boolean;
  /** Sliding window size for tool call history (default: 30). */
  readonly historySize?: number;
  /** Count threshold for issuing warnings (default: 10). */
  readonly warningThreshold?: number;
  /** Count threshold for critical/blocking decisions (default: 20). */
  readonly criticalThreshold?: number;
  /** Hard limit — circuit breaker threshold (default: 30). */
  readonly globalCircuitBreakerThreshold?: number;
  /** Per-detector toggles. */
  readonly detectors?: {
    readonly genericRepeat?: boolean;
    readonly knownPollNoProgress?: boolean;
    readonly pingPong?: boolean;
  };
}

/** A single tool call history record. */
export interface ToolCallHistoryRecord {
  readonly toolName: string;
  readonly argsHash: string;
  readonly toolCallId?: string;
  readonly timestamp: number;
  resultHash?: string;
}

/** Mutable session state containing tool call history. */
export interface ToolCallSessionState {
  toolCallHistory?: ToolCallHistoryRecord[];
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface IToolLoopDetector {
  /**
   * Detect whether the current tool call is part of a repetitive loop.
   * Returns stuck: false if no loop detected, or stuck: true with details.
   */
  detectLoop(
    state: ToolCallSessionState,
    toolName: string,
    params: unknown,
    config?: ToolLoopDetectionConfig,
  ): LoopDetectionResult;

  /**
   * Record a tool call in the session's sliding-window history.
   */
  recordToolCall(
    state: ToolCallSessionState,
    toolName: string,
    params: unknown,
    toolCallId?: string,
    config?: ToolLoopDetectionConfig,
  ): void;

  /**
   * Record a completed tool call outcome (result/error) so loop
   * detection can identify no-progress repeats via result hashing.
   */
  recordToolCallOutcome(
    state: ToolCallSessionState,
    params: {
      toolName: string;
      toolParams: unknown;
      toolCallId?: string;
      result?: unknown;
      error?: unknown;
      config?: ToolLoopDetectionConfig;
    },
  ): void;

  /**
   * Hash a tool call (name + deterministic JSON serialization of params).
   * Exposed for testing and external callers.
   */
  hashToolCall(toolName: string, params: unknown): string;
}
