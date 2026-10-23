/**
 * IContinuousSymbiosisWatcher — Domain port for Continuous Symbiosis (Watch Mode Pipeline).
 *
 * Layer: Domain
 *
 * Monitors donor directories in `external/` for TypeScript file changes
 * and auto-triggers `ISymbioticProtocol.analyzeSystem()` + `generateSidecarAdapter()`
 * when source code is modified (debounced to avoid cascading re-generations).
 *
 * Infrastructure adapter: `src/infrastructure/mcp/extraction/ContinuousSymbiosisWatcher.ts`
 *
 * @see src/domain/extraction/ISymbioticProtocol.ts — Symbiotic Protocol port
 * @see PLANS/DOCS_AUDIT_2026/86_HYPERDEEP_SYMBIOTIC_PROTOCOL_PHASE_11_AUDIT_REPORT.md §4.1
 */

import type { CorrelationId } from '../../core/context/IRequestContext';

// ── Watcher Status ──────────────────────────────────────────────────

/**
 * Snapshot of the continuous symbiosis watcher state.
 */
export interface WatcherStatus {
  /** Whether the watcher is currently monitoring a directory */
  readonly isWatching: boolean;
  /** Path being monitored (null when inactive) */
  readonly donorPath: string | null;
  /** System name for the monitored donor (null when inactive) */
  readonly systemName: string | null;
  /** Total number of completed regeneration cycles */
  readonly regenerationCount: number;
  /** ISO timestamp of last completed regeneration (null if none) */
  readonly lastRegenerationAt: string | null;
}

// ── Domain Port ─────────────────────────────────────────────────────

/**
 * Domain port for the Continuous Symbiosis Watcher (Watch Mode Pipeline).
 *
 * Infrastructure layer implements this by:
 * 1. Setting up a debounced file watcher on a donor directory
 * 2. Filtering for .ts/.tsx changes (ignoring .d.ts, .test.ts, .spec.ts)
 * 3. Re-running `ISymbioticProtocol.analyzeSystem()` on each change batch
 * 4. Auto-regenerating recommended sidecar adapters
 */
export interface IContinuousSymbiosisWatcher {
  /**
   * Start watching a donor directory for changes.
   * Only one directory can be watched at a time — call `stop()` first to change targets.
   */
  start(
    donorPath: string,
    systemName: string,
    correlationId: CorrelationId,
  ): void;

  /** Stop watching the current donor directory and clean up resources. */
  stop(): void;

  /** Get current watcher status snapshot. */
  getStatus(): WatcherStatus;
}
