/**
 * LLM Quality Monitor — runtime quality variance detection.
 *
 * Tracks LLM response quality signals over time, detects degradation
 * windows, and feeds quality data back to IModelRouter for adaptive
 * routing decisions. Based on the 10-layer inference stack model
 * and Anthropic Sep 2025 postmortem findings (MoE routing variance ±8-14%).
 *
 * @layer Domain (port)
 * @module ai
 * @pattern CC-010 LLM Quality Variance Mitigation (FITNESS-K: 81.5)
 * @see src/domain/ai/IModelRouter.ts — model selection consumer of quality signals
 * @see src/infrastructure/factories/LLMAdapterFactory.ts — failover cascades
 * @see src/domain/ai/cost-calculator.types.ts — cost/token accounting
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Quality Signal ─────────────────────────────────────────────────

/**
 * A single quality observation from an LLM response.
 * Collected after each LLM call, fed into the quality time series.
 */
export interface LlmQualitySignal {
  /** Provider identifier (e.g., 'anthropic', 'openai'). */
  readonly provider: string;
  /** Model identifier (e.g., 'claude-4-opus', 'gpt-5.4-codex'). */
  readonly modelId: string;
  /** Response latency (ms). */
  readonly responseTimeMs: number;
  /** Whether the response was valid structured output (JSON). */
  readonly structuredOutputCompliance: boolean;
  /** Optional LLM-as-Judge score (0.0–1.0). Null if not evaluated. */
  readonly judgeScore: number | null;
  /** Response token count. */
  readonly outputTokens: number;
  /** Timestamp of observation. */
  readonly observedAt: Date;
  /** Request correlation ID. */
  readonly correlationId?: string;
}

// ── Quality Assessment ─────────────────────────────────────────────

/**
 * Overall health status of a model.
 */
export type ModelHealthStatus = 'healthy' | 'degraded' | 'critical' | 'unknown';

/**
 * Aggregated quality assessment for a specific provider+model.
 */
export interface QualityAssessment {
  /** Provider identifier. */
  readonly provider: string;
  /** Model identifier. */
  readonly modelId: string;
  /** Current health status. */
  readonly health: ModelHealthStatus;
  /** Average response time over the observation window (ms). */
  readonly avgResponseTimeMs: number;
  /** Structured output compliance rate (0.0–1.0). */
  readonly complianceRate: number;
  /** Average judge score over window (0.0–1.0). Null if no judge scores. */
  readonly avgJudgeScore: number | null;
  /** Number of observations in the current window. */
  readonly sampleCount: number;
  /** Whether quality is trending downward. */
  readonly isDegrading: boolean;
  /** Timestamp of last observation. */
  readonly lastObservedAt: Date;
}

// ── Quality Anomaly ────────────────────────────────────────────────

/**
 * Type of detected quality anomaly.
 */
export type QualityAnomalyType =
  | 'latency_spike'
  | 'compliance_drop'
  | 'judge_score_decline'
  | 'output_truncation'
  | 'error_rate_surge';

/**
 * Severity of a quality anomaly.
 */
export type QualityAnomalySeverity = 'info' | 'warning' | 'critical';

/**
 * A detected quality anomaly event.
 */
export interface QualityAnomaly {
  /** Type of anomaly. */
  readonly type: QualityAnomalyType;
  /** Severity level. */
  readonly severity: QualityAnomalySeverity;
  /** Provider affected. */
  readonly provider: string;
  /** Model affected. */
  readonly modelId: string;
  /** Human-readable description. */
  readonly description: string;
  /** Observed metric value that triggered the anomaly. */
  readonly observedValue: number;
  /** Expected/baseline metric value. */
  readonly baselineValue: number;
  /** When detected. */
  readonly detectedAt: Date;
}

// ── Monitor Configuration ──────────────────────────────────────────

/**
 * Configuration for the quality monitoring window.
 */
export interface QualityMonitorConfig {
  /** Sliding window size for aggregation (ms). Default: 300_000 (5 min). */
  readonly windowMs?: number;
  /** Minimum samples before assessment is valid. Default: 5. */
  readonly minSamples?: number;
  /** Latency spike threshold multiplier over baseline. Default: 2.0. */
  readonly latencySpikeMultiplier?: number;
  /** Minimum compliance rate before degraded. Default: 0.8. */
  readonly minComplianceRate?: number;
  /** Minimum judge score before degraded. Default: 0.6. */
  readonly minJudgeScore?: number;
}

// ── LLM Quality Monitor Port ───────────────────────────────────────

/**
 * Domain port for tracking and assessing LLM quality over time.
 *
 * Consumers (IModelRouter, LLMAdapterFactory) query quality assessments
 * to make informed model selection and failover decisions.
 *
 * @pattern CC-010 LLM Quality Variance Mitigation — 10-layer inference stack model
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface ILlmQualityMonitor {
  /**
   * Record a quality observation from an LLM response.
   * @param signal - Quality signal to record.
   */
  recordSignal(signal: LlmQualitySignal): void;

  /**
   * Get the current quality assessment for a specific model.
   * @param provider - Provider identifier.
   * @param modelId - Model identifier.
   * @returns Quality assessment or null if no data.
   */
  getAssessment(provider: string, modelId: string): QualityAssessment | null;

  /**
   * Get all models currently in degraded or critical state.
   * @returns Array of degraded assessments.
   */
  getDegradedModels(): ReadonlyArray<QualityAssessment>;

  /**
   * Get recent quality anomalies across all monitored models.
   * @param since - Only return anomalies after this timestamp.
   * @returns Array of detected anomalies.
   */
  getAnomalies(since?: Date): ReadonlyArray<QualityAnomaly>;

  /**
   * Check if a model is healthy enough for use.
   * @param provider - Provider identifier.
   * @param modelId - Model identifier.
   * @returns True if model health is 'healthy' or 'unknown'.
   */
  isModelHealthy(provider: string, modelId: string): boolean;

  /**
   * Configure monitoring parameters.
   * @param config - Monitor configuration.
   */
  configure(config: QualityMonitorConfig): void;
}
