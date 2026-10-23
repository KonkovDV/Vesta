/**
 * Stall Detector Adapter — stateless utility for autonomous loop stall detection.
 *
 * Analyzes recent iteration progress deltas to determine if the loop
 * has stalled (no meaningful progress across consecutive iterations).
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-009 sub-component: progress-delta stall detection
 * @see src/domain/agents/IAutonomousExecutionLoop.ts — IStallDetector port
 */

import type {
  IStallDetector,
  IterationSnapshot,
  LoopBounds,
  StallDetectionResult,
} from '../../domain/agents/IAutonomousExecutionLoop';

// ── Constants ─────────────────────────────────────────────────────

const DEFAULT_PROGRESS_THRESHOLD = 0.01;
const DEFAULT_STALL_WINDOW_SIZE = 3;

// ── Adapter ───────────────────────────────────────────────────────

export class StallDetectorAdapter implements IStallDetector {
  detectStall(
    snapshots: ReadonlyArray<IterationSnapshot>,
    bounds: LoopBounds,
  ): StallDetectionResult {
    const windowSize = bounds.stallWindowSize ?? DEFAULT_STALL_WINDOW_SIZE;
    const threshold = bounds.progressThreshold ?? DEFAULT_PROGRESS_THRESHOLD;

    if (snapshots.length < windowSize) {
      return { isStalled: false, consecutiveStalls: 0, recommendation: 'continue' };
    }

    // Count consecutive non-progressing iterations from the end
    let consecutiveStalls = 0;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i].progressDelta < threshold) {
        consecutiveStalls++;
      } else {
        break;
      }
    }

    const isStalled = consecutiveStalls >= windowSize;

    let recommendation: 'continue' | 'escalate' | 'abort';
    if (!isStalled) {
      recommendation = 'continue';
    } else if (consecutiveStalls >= windowSize * 2) {
      recommendation = 'abort';
    } else {
      recommendation = 'escalate';
    }

    return { isStalled, consecutiveStalls, recommendation };
  }
}
