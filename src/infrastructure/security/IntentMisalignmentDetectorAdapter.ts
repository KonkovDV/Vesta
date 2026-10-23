/**
 * IntentMisalignmentDetectorAdapter — Heuristic-based IBAC 2.0 intent analysis.
 *
 * In-memory implementation of IIntentMisalignmentDetector. Evaluates tool calls
 * against the stated task intent using keyword-based semantic distance heuristics,
 * maintains a sliding trajectory window, and generates worst-case interpretations.
 *
 * In production, the semantic distance calculation would be delegated to an embedding
 * model via LLMAdapterFactory. This adapter uses keyword overlap as approximation.
 *
 * @layer Infrastructure (Security)
 * @pattern CC-026 Intent Misalignment Detector (PUA v5.1 → IBAC 2.0)
 * @see src/domain/security/IIntentMisalignmentDetector.ts — domain port
 * @see src/core/events/intent-misalignment.schemas.ts — Zod validation schemas
 */

import type {
  IIntentMisalignmentDetector,
  IntentAlignment,
  IntentTrajectoryEntry,
  WorstCaseInterpretation,
  MisalignmentVerdict,
  MisalignmentConfig,
} from '../../domain/security/IIntentMisalignmentDetector';
import { DEFAULT_MISALIGNMENT_CONFIG } from '../../domain/security/IIntentMisalignmentDetector';

// ── Minimal Logger ────────────────────────────────────────────────

interface DetectorLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── PUA Anti-Rationalization Excuses (from PUA v5.0-Alpha table) ──

const RATIONALIZATION_PATTERNS: ReadonlyArray<{ pattern: RegExp; excuse: string }> = [
  { pattern: /beyond\s+(my\s+)?capabilit/i, excuse: 'Beyond my capabilities' },
  { pattern: /suggest\s+(you\s+)?(user\s+)?handle\s+manually/i, excuse: 'Suggest user handle manually' },
  { pattern: /already\s+tried\s+everything/i, excuse: 'Already tried everything' },
  { pattern: /probably\s+(an?\s+)?environment\s+issue/i, excuse: 'Probably environment issue' },
  { pattern: /need\s+more\s+context/i, excuse: 'Need more context' },
  { pattern: /api\s+doesn.?t\s+support/i, excuse: 'API doesn\'t support it' },
  { pattern: /cannot\s+solve/i, excuse: 'Cannot solve this problem' },
  { pattern: /out\s+of\s+scope/i, excuse: 'This is out of scope' },
];

// ── Dangerous Tool Patterns ───────────────────────────────────────

const DESTRUCTIVE_TOOLS = new Set([
  'rm', 'delete', 'drop', 'truncate', 'force_push', 'reset_hard',
]);

// ── Adapter ───────────────────────────────────────────────────────

export class IntentMisalignmentDetectorAdapter implements IIntentMisalignmentDetector {
  private readonly trajectory: IntentTrajectoryEntry[] = [];
  private taskIntent = '';

  constructor(private readonly logger?: DetectorLogger) {}

  analyze(
    toolName: string,
    argumentsSummary: string,
    taskIntent: string,
    config: MisalignmentConfig = DEFAULT_MISALIGNMENT_CONFIG,
  ): MisalignmentVerdict {
    // Calculate semantic distance (keyword overlap heuristic)
    const semanticDistance = this.calculateSemanticDistance(
      toolName + ' ' + argumentsSummary,
      taskIntent,
    );

    // Add to trajectory window
    const entry: IntentTrajectoryEntry = {
      toolName,
      argumentsSummary,
      taskIntent,
      semanticDistance,
      timestamp: new Date().toISOString(),
    };
    this.trajectory.push(entry);

    // Trim to window size
    while (this.trajectory.length > config.windowSize) {
      this.trajectory.shift();
    }

    // Update stored task intent
    this.taskIntent = taskIntent;

    // Generate worst-case interpretation
    const worstCase = this.generateWorstCase(toolName, argumentsSummary);

    // Calculate cumulative drift from trajectory
    const currentDrift = this.calculateCumulativeDrift();

    // Determine alignment
    const alignment = this.classifyAlignment(currentDrift, config);

    // Determine drift trend
    const driftTrend = this.calculateDriftTrend();

    // Check Context Locking
    const contextLockingRequired = currentDrift > config.contextLockThreshold;

    const verdict: MisalignmentVerdict = {
      alignment,
      worstCase,
      currentDrift,
      trajectoryLength: this.trajectory.length,
      driftTrend,
      contextLockingRequired,
      summary: this.formatSummary(alignment, currentDrift, worstCase, contextLockingRequired),
      analyzedAt: new Date().toISOString(),
    };

    if (alignment !== 'aligned') {
      this.logger?.warn('Intent misalignment detected', {
        alignment,
        currentDrift,
        toolName,
        contextLockingRequired,
      });
    } else {
      this.logger?.info('Intent aligned', {
        toolName,
        currentDrift,
      });
    }

    return verdict;
  }

  getTrajectory(): readonly IntentTrajectoryEntry[] {
    return [...this.trajectory];
  }

  setTaskIntent(taskIntent: string): void {
    this.taskIntent = taskIntent;
    // Reset trajectory when intent changes
    this.trajectory.length = 0;
    this.logger?.info('Task intent updated, trajectory reset', { taskIntent });
  }

  reset(): void {
    this.trajectory.length = 0;
    this.taskIntent = '';
    this.logger?.info('Intent Misalignment Detector reset');
  }

  // ── Private Helpers ─────────────────────────────────────────

  private calculateSemanticDistance(actionText: string, intent: string): number {
    // Keyword overlap heuristic: lower overlap → higher distance
    const actionTokens = new Set(this.tokenize(actionText));
    const intentTokens = new Set(this.tokenize(intent));

    if (intentTokens.size === 0 || actionTokens.size === 0) return 0.5;

    let overlap = 0;
    for (const token of intentTokens) {
      if (actionTokens.has(token)) overlap++;
    }

    const jaccardSimilarity = overlap / (actionTokens.size + intentTokens.size - overlap);
    return 1 - jaccardSimilarity;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length > 2);
  }

  private generateWorstCase(toolName: string, argumentsSummary: string): WorstCaseInterpretation {
    // Check for destructive tool patterns
    const isDestructive = DESTRUCTIVE_TOOLS.has(toolName.toLowerCase());

    // Check for PUA rationalization patterns in arguments
    let matchedExcuse: string | undefined;
    let isRationalizationBypass = false;
    for (const { pattern, excuse } of RATIONALIZATION_PATTERNS) {
      if (pattern.test(argumentsSummary)) {
        matchedExcuse = excuse;
        isRationalizationBypass = true;
        break;
      }
    }

    const severity = isDestructive ? 'critical' as const
      : isRationalizationBypass ? 'high' as const
      : 'low' as const;

    const description = isDestructive
      ? `Tool "${toolName}" could perform irreversible destructive action`
      : isRationalizationBypass
        ? 'Arguments contain rationalization bypass pattern: "' + String(matchedExcuse ?? 'unknown') + '"'
        : `Tool "${toolName}" could drift from stated intent if arguments are misinterpreted`;

    return {
      description,
      severity,
      isRationalizationBypass,
      ...(matchedExcuse && { matchedExcuse }),
    };
  }

  private calculateCumulativeDrift(): number {
    if (this.trajectory.length === 0) return 0;

    // Weighted average — recent entries weighted more heavily
    let weightedSum = 0;
    let weightSum = 0;
    for (let i = 0; i < this.trajectory.length; i++) {
      const weight = (i + 1) / this.trajectory.length;
      weightedSum += this.trajectory[i].semanticDistance * weight;
      weightSum += weight;
    }

    return weightSum > 0 ? weightedSum / weightSum : 0;
  }

  private classifyAlignment(drift: number, config: MisalignmentConfig): IntentAlignment {
    if (drift >= config.misalignedThreshold) return 'misaligned';
    if (drift >= config.driftingThreshold) return 'drifting';
    return 'aligned';
  }

  private calculateDriftTrend(): 'increasing' | 'stable' | 'decreasing' {
    if (this.trajectory.length < 3) return 'stable';

    const halfIdx = Math.floor(this.trajectory.length / 2);
    const firstHalf = this.trajectory.slice(0, halfIdx);
    const secondHalf = this.trajectory.slice(halfIdx);

    const avgFirst = firstHalf.reduce((s, e) => s + e.semanticDistance, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, e) => s + e.semanticDistance, 0) / secondHalf.length;

    const diff = avgSecond - avgFirst;
    if (diff > 0.05) return 'increasing';
    if (diff < -0.05) return 'decreasing';
    return 'stable';
  }

  private formatSummary(
    alignment: IntentAlignment,
    drift: number,
    worstCase: WorstCaseInterpretation,
    contextLocking: boolean,
  ): string {
    const parts: string[] = [
      `Alignment: ${alignment} (drift: ${drift.toFixed(3)})`,
    ];
    if (worstCase.isRationalizationBypass) {
      parts.push('Rationalization bypass detected: "' + String(worstCase.matchedExcuse ?? 'unknown') + '"');
    }
    if (contextLocking) {
      parts.push('Context Locking activated — intent drift exceeded threshold');
    }
    return parts.join('. ');
  }
}
