/**
 * LLM Quality Monitor Adapter — runtime quality variance detection.
 *
 * Sliding-window aggregation of LLM response quality signals with
 * threshold-based anomaly detection. In-memory state (no persistence).
 *
 * FP-03 resolution: Exposes quality data for IModelRouter integration
 * via DI composition (Phase 3 — DynamicLLMRouterService can optionally
 * inject ILlmQualityMonitor).
 *
 * @layer Infrastructure (AI)
 * @pattern CC-010 LLM Quality Variance Mitigation (FITNESS-K: 81.5)
 * @see src/domain/ai/ILlmQualityMonitor.ts — domain port
 * @see src/domain/ai/IModelRouter.ts — integration consumer
 */

import type {
  ILlmQualityMonitor,
  LlmQualitySignal,
  QualityAssessment,
  QualityAnomaly,
  QualityAnomalyType,
  QualityAnomalySeverity,
  QualityMonitorConfig,
  ModelHealthStatus,
} from '../../domain/ai/ILlmQualityMonitor';

// ── Minimal Logger ────────────────────────────────────────────────

interface MonitorLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 300_000;           // 5 minutes
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_LATENCY_SPIKE_MULTIPLIER = 2.0;
const DEFAULT_MIN_COMPLIANCE_RATE = 0.8;
const DEFAULT_MIN_JUDGE_SCORE = 0.6;

// ── Adapter ───────────────────────────────────────────────────────

export class LlmQualityMonitorAdapter implements ILlmQualityMonitor {
  /** Signals per model key (provider:modelId). */
  private readonly signals = new Map<string, LlmQualitySignal[]>();
  /** Detected anomalies. */
  private readonly anomalies: QualityAnomaly[] = [];
  /** Active config. */
  private config: Required<QualityMonitorConfig>;

  constructor(private readonly logger?: MonitorLogger) {
    this.config = {
      windowMs: DEFAULT_WINDOW_MS,
      minSamples: DEFAULT_MIN_SAMPLES,
      latencySpikeMultiplier: DEFAULT_LATENCY_SPIKE_MULTIPLIER,
      minComplianceRate: DEFAULT_MIN_COMPLIANCE_RATE,
      minJudgeScore: DEFAULT_MIN_JUDGE_SCORE,
    };
  }

  recordSignal(signal: LlmQualitySignal): void {
    const key = this.modelKey(signal.provider, signal.modelId);
    let bucket = this.signals.get(key);
    if (!bucket) {
      bucket = [];
      this.signals.set(key, bucket);
    }
    bucket.push(signal);

    // Prune old signals outside window
    this.pruneWindow(bucket);

    // Check for anomalies on each signal
    this.detectAnomalies(signal, bucket);
  }

  getAssessment(provider: string, modelId: string): QualityAssessment | null {
    const key = this.modelKey(provider, modelId);
    const bucket = this.signals.get(key);
    if (!bucket || bucket.length === 0) return null;

    this.pruneWindow(bucket);
    if (bucket.length === 0) return null;

    return this.buildAssessment(provider, modelId, bucket);
  }

  getDegradedModels(): ReadonlyArray<QualityAssessment> {
    const degraded: QualityAssessment[] = [];
    for (const [key, bucket] of this.signals) {
      this.pruneWindow(bucket);
      if (bucket.length === 0) continue;
      const [provider, modelId] = key.split(':');
      const assessment = this.buildAssessment(provider, modelId, bucket);
      if (assessment.health === 'degraded' || assessment.health === 'critical') {
        degraded.push(assessment);
      }
    }
    return degraded;
  }

  getAnomalies(since?: Date): ReadonlyArray<QualityAnomaly> {
    if (!since) return [...this.anomalies];
    const sinceMs = since.getTime();
    return this.anomalies.filter(a => a.detectedAt.getTime() >= sinceMs);
  }

  isModelHealthy(provider: string, modelId: string): boolean {
    const assessment = this.getAssessment(provider, modelId);
    if (!assessment) return true; // unknown = healthy (not enough data)
    return assessment.health === 'healthy' || assessment.health === 'unknown';
  }

  configure(config: QualityMonitorConfig): void {
    this.config = {
      windowMs: config.windowMs ?? this.config.windowMs,
      minSamples: config.minSamples ?? this.config.minSamples,
      latencySpikeMultiplier: config.latencySpikeMultiplier ?? this.config.latencySpikeMultiplier,
      minComplianceRate: config.minComplianceRate ?? this.config.minComplianceRate,
      minJudgeScore: config.minJudgeScore ?? this.config.minJudgeScore,
    };

    this.logger?.info('Quality monitor reconfigured', {
      windowMs: this.config.windowMs,
      minSamples: this.config.minSamples,
    });
  }

  // ── Private ─────────────────────────────────────────────────────

  private modelKey(provider: string, modelId: string): string {
    return `${provider}:${modelId}`;
  }

  private pruneWindow(bucket: LlmQualitySignal[]): void {
    const cutoff = Date.now() - this.config.windowMs;
    // Remove signals older than window — mutate in-place
    let i = 0;
    while (i < bucket.length && bucket[i].observedAt.getTime() < cutoff) {
      i++;
    }
    if (i > 0) bucket.splice(0, i);
  }

  private buildAssessment(
    provider: string,
    modelId: string,
    bucket: LlmQualitySignal[],
  ): QualityAssessment {
    const sampleCount = bucket.length;
    const avgResponseTimeMs = bucket.reduce((s, sig) => s + sig.responseTimeMs, 0) / sampleCount;
    const complianceRate = bucket.filter(s => s.structuredOutputCompliance).length / sampleCount;

    const judgeSignals = bucket.filter(s => s.judgeScore !== null);
    const avgJudgeScore = judgeSignals.length > 0
      ? judgeSignals.reduce((s, sig) => s + (sig.judgeScore ?? 0), 0) / judgeSignals.length
      : null;

    const lastObservedAt = bucket[bucket.length - 1].observedAt;

    // Determine health
    let health: ModelHealthStatus;
    if (sampleCount < this.config.minSamples) {
      health = 'unknown';
    } else if (
      complianceRate < this.config.minComplianceRate * 0.5 ||
      (avgJudgeScore !== null && avgJudgeScore < this.config.minJudgeScore * 0.5)
    ) {
      health = 'critical';
    } else if (
      complianceRate < this.config.minComplianceRate ||
      (avgJudgeScore !== null && avgJudgeScore < this.config.minJudgeScore)
    ) {
      health = 'degraded';
    } else {
      health = 'healthy';
    }

    // Determine trend: compare first half vs second half
    const mid = Math.floor(sampleCount / 2);
    const firstHalf = bucket.slice(0, mid);
    const secondHalf = bucket.slice(mid);
    const firstAvg = firstHalf.length > 0
      ? firstHalf.reduce((s, sig) => s + sig.responseTimeMs, 0) / firstHalf.length
      : 0;
    const secondAvg = secondHalf.length > 0
      ? secondHalf.reduce((s, sig) => s + sig.responseTimeMs, 0) / secondHalf.length
      : 0;
    const isDegrading = secondAvg > firstAvg * 1.2; // 20% worse

    return {
      provider,
      modelId,
      health,
      avgResponseTimeMs,
      complianceRate,
      avgJudgeScore,
      sampleCount,
      isDegrading,
      lastObservedAt,
    };
  }

  private detectAnomalies(signal: LlmQualitySignal, bucket: LlmQualitySignal[]): void {
    if (bucket.length < this.config.minSamples) return;

    const avgLatency = bucket.reduce((s, sig) => s + sig.responseTimeMs, 0) / bucket.length;

    // Latency spike
    if (signal.responseTimeMs > avgLatency * this.config.latencySpikeMultiplier) {
      this.addAnomaly({
        type: 'latency_spike',
        severity: signal.responseTimeMs > avgLatency * this.config.latencySpikeMultiplier * 2 ? 'critical' : 'warning',
        provider: signal.provider,
        modelId: signal.modelId,
        description: `Latency ${signal.responseTimeMs}ms exceeds ${this.config.latencySpikeMultiplier}x baseline ${Math.round(avgLatency)}ms`,
        observedValue: signal.responseTimeMs,
        baselineValue: avgLatency,
        detectedAt: new Date(),
      });
    }

    // Compliance drop
    if (!signal.structuredOutputCompliance) {
      const complianceRate = bucket.filter(s => s.structuredOutputCompliance).length / bucket.length;
      if (complianceRate < this.config.minComplianceRate) {
        this.addAnomaly({
          type: 'compliance_drop',
          severity: complianceRate < this.config.minComplianceRate * 0.5 ? 'critical' : 'warning',
          provider: signal.provider,
          modelId: signal.modelId,
          description: `Compliance rate ${(complianceRate * 100).toFixed(1)}% below threshold ${(this.config.minComplianceRate * 100).toFixed(1)}%`,
          observedValue: complianceRate,
          baselineValue: this.config.minComplianceRate,
          detectedAt: new Date(),
        });
      }
    }

    // Judge score decline
    if (signal.judgeScore !== null && signal.judgeScore < this.config.minJudgeScore) {
      this.addAnomaly({
        type: 'judge_score_decline',
        severity: signal.judgeScore < this.config.minJudgeScore * 0.5 ? 'critical' : 'warning',
        provider: signal.provider,
        modelId: signal.modelId,
        description: `Judge score ${signal.judgeScore.toFixed(2)} below threshold ${this.config.minJudgeScore}`,
        observedValue: signal.judgeScore,
        baselineValue: this.config.minJudgeScore,
        detectedAt: new Date(),
      });
    }
  }

  private addAnomaly(anomaly: QualityAnomaly): void {
    this.anomalies.push(anomaly);
    this.logger?.warn('Quality anomaly detected', {
      type: anomaly.type,
      severity: anomaly.severity,
      provider: anomaly.provider,
      modelId: anomaly.modelId,
    });
  }
}
