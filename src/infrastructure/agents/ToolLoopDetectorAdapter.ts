/**
 * Tool Loop Detector — Infrastructure adapter for IToolLoopDetector.
 *
 * Detects repetitive tool call loops in agentic AI sessions using 4 strategies:
 * generic_repeat, known_poll_no_progress, ping_pong, global_circuit_breaker.
 *
 * @layer Infrastructure (Agents)
 * @phase OpenClaw Extraction V4 — Sprint 2
 * @donor external/openclaw/src/agents/tool-loop-detection.ts (560L, 1 dep: node:crypto)
 * @owasp Agentic Top 10 2026: Resource Exhaustion, Infinite Loop DoS
 */

import { createHash } from 'node:crypto';
import type {
  IToolLoopDetector,
  LoopDetectionResult,
  ToolLoopDetectionConfig,
  ToolCallSessionState,
  ToolCallHistoryRecord,
} from '../../domain/agents/tool-loop-detector.port';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_HISTORY_SIZE = 30;
const DEFAULT_WARNING_THRESHOLD = 10;
const DEFAULT_CRITICAL_THRESHOLD = 20;
const DEFAULT_GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;

interface ResolvedConfig {
  enabled: boolean;
  historySize: number;
  warningThreshold: number;
  criticalThreshold: number;
  globalCircuitBreakerThreshold: number;
  detectors: {
    genericRepeat: boolean;
    knownPollNoProgress: boolean;
    pingPong: boolean;
  };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function asPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function resolveConfig(config?: ToolLoopDetectionConfig): ResolvedConfig {
  let warningThreshold = asPositiveInt(config?.warningThreshold, DEFAULT_WARNING_THRESHOLD);
  let criticalThreshold = asPositiveInt(config?.criticalThreshold, DEFAULT_CRITICAL_THRESHOLD);
  let globalCircuitBreakerThreshold = asPositiveInt(
    config?.globalCircuitBreakerThreshold,
    DEFAULT_GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
  );

  if (criticalThreshold <= warningThreshold) {
    criticalThreshold = warningThreshold + 1;
  }
  if (globalCircuitBreakerThreshold <= criticalThreshold) {
    globalCircuitBreakerThreshold = criticalThreshold + 1;
  }

  return {
    enabled: config?.enabled ?? true,
    historySize: asPositiveInt(config?.historySize, DEFAULT_HISTORY_SIZE),
    warningThreshold,
    criticalThreshold,
    globalCircuitBreakerThreshold,
    detectors: {
      genericRepeat: config?.detectors?.genericRepeat ?? true,
      knownPollNoProgress: config?.detectors?.knownPollNoProgress ?? true,
      pingPong: config?.detectors?.pingPong ?? true,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function digestStable(value: unknown): string {
  let serialized: string;
  try {
    serialized = stableStringify(value);
  } catch {
    serialized = String(value ?? 'null');
  }
  return createHash('sha256').update(serialized).digest('hex');
}

function isKnownPollToolCall(toolName: string, params: unknown): boolean {
  if (toolName === 'command_status') return true;
  if (toolName !== 'process' || !isPlainObject(params)) return false;
  const action = params.action;
  return action === 'poll' || action === 'log';
}

function extractTextContent(result: unknown): string {
  if (!isPlainObject(result) || !Array.isArray(result.content)) return '';
  return result.content
    .filter(
      (entry: unknown): entry is { type: string; text: string } =>
        isPlainObject(entry) && typeof entry.type === 'string' && typeof entry.text === 'string',
    )
    .map((entry: { text: string }) => entry.text)
    .join('\n')
    .trim();
}

function formatErrorForHash(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return stableStringify(error);
}

function hashToolOutcome(
  toolName: string,
  params: unknown,
  result: unknown,
  error: unknown,
): string | undefined {
  if (error !== undefined) {
    return `error:${digestStable(formatErrorForHash(error))}`;
  }
  if (!isPlainObject(result)) {
    return result === undefined ? undefined : digestStable(result);
  }
  const details = isPlainObject(result.details) ? result.details : {};
  const text = extractTextContent(result);

  if (isKnownPollToolCall(toolName, params) && toolName === 'process' && isPlainObject(params)) {
    const action = params.action;
    if (action === 'poll') {
      return digestStable({
        action,
        status: details.status,
        exitCode: details.exitCode ?? null,
        exitSignal: details.exitSignal ?? null,
        text,
      });
    }
    if (action === 'log') {
      return digestStable({
        action,
        status: details.status,
        totalLines: details.totalLines ?? null,
        text,
      });
    }
  }

  return digestStable({ details, text });
}

function getNoProgressStreak(
  history: ToolCallHistoryRecord[],
  toolName: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName || record.argsHash !== argsHash) continue;
    if (typeof record.resultHash !== 'string' || !record.resultHash) continue;
    if (!latestResultHash) {
      latestResultHash = record.resultHash;
      streak = 1;
      continue;
    }
    if (record.resultHash !== latestResultHash) break;
    streak += 1;
  }

  return { count: streak, latestResultHash };
}

function getPingPongStreak(
  history: ToolCallHistoryRecord[],
  currentSignature: string,
): { count: number; pairedToolName?: string; noProgressEvidence: boolean } {
  const last = history.at(-1);
  if (!last) return { count: 0, noProgressEvidence: false };

  let otherSignature: string | undefined;
  let otherToolName: string | undefined;
  for (let i = history.length - 2; i >= 0; i -= 1) {
    const call = history[i];
    if (!call) continue;
    if (call.argsHash !== last.argsHash) {
      otherSignature = call.argsHash;
      otherToolName = call.toolName;
      break;
    }
  }

  if (!otherSignature || !otherToolName) return { count: 0, noProgressEvidence: false };

  let alternatingTailCount = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const call = history[i];
    if (!call) continue;
    const expected = alternatingTailCount % 2 === 0 ? last.argsHash : otherSignature;
    if (call.argsHash !== expected) break;
    alternatingTailCount += 1;
  }

  if (alternatingTailCount < 2) return { count: 0, noProgressEvidence: false };
  if (currentSignature !== otherSignature) return { count: 0, noProgressEvidence: false };

  const tailStart = Math.max(0, history.length - alternatingTailCount);
  let firstHashA: string | undefined;
  let firstHashB: string | undefined;
  let noProgressEvidence = true;
  for (let i = tailStart; i < history.length; i += 1) {
    const call = history[i];
    if (!call || !call.resultHash) {
      noProgressEvidence = false;
      break;
    }
    if (call.argsHash === last.argsHash) {
      if (!firstHashA) { firstHashA = call.resultHash; }
      else if (firstHashA !== call.resultHash) { noProgressEvidence = false; break; }
    } else if (call.argsHash === otherSignature) {
      if (!firstHashB) { firstHashB = call.resultHash; }
      else if (firstHashB !== call.resultHash) { noProgressEvidence = false; break; }
    } else {
      noProgressEvidence = false;
      break;
    }
  }

  if (!firstHashA || !firstHashB) noProgressEvidence = false;

  return {
    count: alternatingTailCount + 1,
    pairedToolName: last.toolName,
    noProgressEvidence,
  };
}

function canonicalPairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class ToolLoopDetectorAdapter implements IToolLoopDetector {
  hashToolCall(toolName: string, params: unknown): string {
    return `${toolName}:${digestStable(params)}`;
  }

  detectLoop(
    state: ToolCallSessionState,
    toolName: string,
    params: unknown,
    config?: ToolLoopDetectionConfig,
  ): LoopDetectionResult {
    const rc = resolveConfig(config);
    if (!rc.enabled) return { stuck: false };

    const history = state.toolCallHistory ?? [];
    const currentHash = this.hashToolCall(toolName, params);
    const noProgress = getNoProgressStreak(history, toolName, currentHash);
    const noProgressStreak = noProgress.count;
    const knownPollTool = isKnownPollToolCall(toolName, params);
    const pingPong = getPingPongStreak(history, currentHash);

    // Global circuit breaker
    if (noProgressStreak >= rc.globalCircuitBreakerThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'global_circuit_breaker',
        count: noProgressStreak,
        message: `CRITICAL: ${toolName} has repeated identical no-progress outcomes ${noProgressStreak} times. Session execution blocked by global circuit breaker.`,
        warningKey: `global:${toolName}:${currentHash}:${noProgress.latestResultHash ?? 'none'}`,
      };
    }

    // Known poll no-progress: critical
    if (
      knownPollTool &&
      rc.detectors.knownPollNoProgress &&
      noProgressStreak >= rc.criticalThreshold
    ) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'known_poll_no_progress',
        count: noProgressStreak,
        message: `CRITICAL: Called ${toolName} with identical arguments and no progress ${noProgressStreak} times. Stuck polling loop detected.`,
        warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? 'none'}`,
      };
    }

    // Known poll no-progress: warning
    if (
      knownPollTool &&
      rc.detectors.knownPollNoProgress &&
      noProgressStreak >= rc.warningThreshold
    ) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'known_poll_no_progress',
        count: noProgressStreak,
        message: `WARNING: ${toolName} called ${noProgressStreak} times with identical arguments and no progress.`,
        warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? 'none'}`,
      };
    }

    // Ping-pong: critical
    const pingPongWarningKey = `pingpong:${canonicalPairKey(currentHash, currentHash)}`;
    if (
      rc.detectors.pingPong &&
      pingPong.count >= rc.criticalThreshold &&
      pingPong.noProgressEvidence
    ) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'ping_pong',
        count: pingPong.count,
        message: `CRITICAL: Alternating tool-call patterns (${pingPong.count} consecutive calls) with no progress. Ping-pong loop detected.`,
        pairedToolName: pingPong.pairedToolName,
        warningKey: pingPongWarningKey,
      };
    }

    // Ping-pong: warning
    if (rc.detectors.pingPong && pingPong.count >= rc.warningThreshold) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'ping_pong',
        count: pingPong.count,
        message: `WARNING: Alternating tool-call patterns (${pingPong.count} consecutive calls). Possible ping-pong loop.`,
        pairedToolName: pingPong.pairedToolName,
        warningKey: pingPongWarningKey,
      };
    }

    // Generic repeat: warning only
    const recentCount = history.filter(
      (h) => h.toolName === toolName && h.argsHash === currentHash,
    ).length;

    if (
      !knownPollTool &&
      rc.detectors.genericRepeat &&
      recentCount >= rc.warningThreshold
    ) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'generic_repeat',
        count: recentCount,
        message: `WARNING: ${toolName} called ${recentCount} times with identical arguments.`,
        warningKey: `generic:${toolName}:${currentHash}`,
      };
    }

    return { stuck: false };
  }

  recordToolCall(
    state: ToolCallSessionState,
    toolName: string,
    params: unknown,
    toolCallId?: string,
    config?: ToolLoopDetectionConfig,
  ): void {
    const rc = resolveConfig(config);
    if (!state.toolCallHistory) {
      state.toolCallHistory = [];
    }

    state.toolCallHistory.push({
      toolName,
      argsHash: this.hashToolCall(toolName, params),
      toolCallId,
      timestamp: Date.now(),
    });

    if (state.toolCallHistory.length > rc.historySize) {
      state.toolCallHistory.shift();
    }
  }

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
  ): void {
    const resultHash = hashToolOutcome(
      params.toolName,
      params.toolParams,
      params.result,
      params.error,
    );
    if (!resultHash) return;

    if (!state.toolCallHistory) {
      state.toolCallHistory = [];
    }

    const argsHash = this.hashToolCall(params.toolName, params.toolParams);
    for (let i = state.toolCallHistory.length - 1; i >= 0; i -= 1) {
      const call = state.toolCallHistory[i];
      if (!call) continue;
      if (call.toolName === params.toolName && call.argsHash === argsHash && !call.resultHash) {
        call.resultHash = resultHash;
        return;
      }
    }
  }
}
