/**
 * ContinuousSymbiosisWatcher — Watch Mode Pipeline for Inverse Symbiosis.
 *
 * Layer: Infrastructure
 *
 * Monitors donor directories within `external/` for TypeScript file changes
 * and automatically re-triggers `analyzeSystem()` + `generateSidecarAdapter()`
 * when donor code changes. Implements debounced fs.watch() following the
 * existing pattern from MicroPhoenixDocsMcpServer.ts.
 *
 * Uses constructor injection for all dependencies (Hard Rule #13).
 * Events are implicitly emitted via ISymbioticProtocol methods (Outbox-first, Hard Rule #4).
 *
 * @see src/infrastructure/mcp/extraction/SymbioticProtocolAdapter.ts — Symbiotic Protocol adapter
 * @see PLANS/DOCS_AUDIT_2026/86_HYPERDEEP_SYMBIOTIC_PROTOCOL_PHASE_11_AUDIT_REPORT.md §4.1
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CorrelationId } from '../../../core/context/IRequestContext';
import type { IStructuredLogger } from '../../../core/logging/IStructuredLogger';
import type { ISymbioticProtocol } from '../../../domain/extraction/ISymbioticProtocol';
import type { IContinuousSymbiosisWatcher, WatcherStatus } from '../../../domain/extraction/IContinuousSymbiosisWatcher';

// ── Constants ─────────────────────────────────────────────────────

/** Debounce interval (ms) to batch rapid file changes */
const DEBOUNCE_MS = 500;

/** File extensions that trigger re-analysis */
const WATCHED_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Extensions to ignore. Note: `path.extname('foo.d.ts')` returns `'.ts'` (not `'.d.ts'`),
 * so `.d.ts` files pass the WATCHED_EXTENSIONS filter. The IGNORED_EXTENSIONS check
 * catches them via `filename.endsWith()` — this is intentional design, not a bug.
 */
const IGNORED_EXTENSIONS = new Set(['.d.ts', '.test.ts', '.spec.ts']);

// ── Watcher Implementation ────────────────────────────────────────

/**
 * Continuous Symbiosis watcher — monitors donor directories for changes
 * and re-generates sidecar adapters automatically.
 *
 * Uses Node.js built-in `fs.watch()` with recursive option (Node.js 24+).
 * Following the existing watcher pattern from MicroPhoenixDocsMcpServer.ts.
 */
export class ContinuousSymbiosisWatcher implements IContinuousSymbiosisWatcher {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private donorPath: string | null = null;
  private systemName: string | null = null;
  private correlationId: CorrelationId | null = null;
  private regenerationCount = 0;
  private lastRegenerationAt: string | null = null;
  private pendingRegeneration = false;

  constructor(
    private readonly symbioticProtocol: ISymbioticProtocol,
    private readonly logger: IStructuredLogger,
  ) {}

  /**
   * Start watching a donor directory for changes.
   * Only one directory can be watched at a time — call stop() first to change targets.
   */
  start(
    donorPath: string,
    systemName: string,
    correlationId: CorrelationId,
  ): void {
    if (this.watcher) {
      this.logger.warn('Watcher already active, stop first', {
        currentPath: this.donorPath,
        requestedPath: donorPath,
      });
      return;
    }

    // Resolve and validate path exists
    const resolvedPath = path.resolve(donorPath);
    if (!fs.existsSync(resolvedPath)) {
      this.logger.warn('Donor path does not exist', { donorPath: resolvedPath });
      return;
    }

    this.donorPath = donorPath;
    this.systemName = systemName;
    this.correlationId = correlationId;
    this.regenerationCount = 0;
    this.lastRegenerationAt = null;

    try {
      this.watcher = fs.watch(resolvedPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Only react to TypeScript file changes
        const ext = path.extname(filename);
        if (!WATCHED_EXTENSIONS.has(ext)) return;
        if (IGNORED_EXTENSIONS.has(ext) || Array.from(IGNORED_EXTENSIONS).some(ie => filename.endsWith(ie))) return;

        this.scheduleRegeneration(filename);
      });

      this.watcher.on('error', (error) => {
        this.logger.warn('File watcher error', {
          donorPath,
          error: error.message,
        });
      });

      this.logger.info('Continuous Symbiosis watcher started', {
        donorPath,
        systemName,
        correlationId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to start watcher', {
        donorPath,
        error: message,
      });
      this.watcher = null;
    }
  }

  /**
   * Stop watching the current donor directory.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;

      this.logger.info('Continuous Symbiosis watcher stopped', {
        donorPath: this.donorPath,
        systemName: this.systemName,
        regenerationCount: this.regenerationCount,
      });
    }

    this.donorPath = null;
    this.systemName = null;
    this.correlationId = null;
  }

  /**
   * Get current watcher status.
   */
  getStatus(): WatcherStatus {
    return {
      isWatching: this.watcher !== null,
      donorPath: this.donorPath,
      systemName: this.systemName,
      regenerationCount: this.regenerationCount,
      lastRegenerationAt: this.lastRegenerationAt,
    };
  }

  // ── Private ───────────────────────────────────────────────────

  /**
   * Schedule debounced re-analysis + regeneration.
   * Batches rapid file changes into a single regeneration cycle.
   */
  private scheduleRegeneration(changedFile: string): void {
    this.logger.info('File change detected', {
      changedFile,
      donorPath: this.donorPath,
    });

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runRegeneration(changedFile);
    }, DEBOUNCE_MS);
  }

  /**
   * Run the full regeneration cycle: analyze → generate for each recommendation.
   * Serialized — only one regeneration runs at a time.
   */
  private async runRegeneration(triggerFile: string): Promise<void> {
    if (this.pendingRegeneration) return;
    if (!this.donorPath || !this.systemName || !this.correlationId) return;

    this.pendingRegeneration = true;

    try {
      this.logger.info('Regeneration cycle started', {
        triggerFile,
        donorPath: this.donorPath,
        systemName: this.systemName,
        cycle: this.regenerationCount + 1,
      });

      // Step 1: Re-analyze the system
      const analysis = await this.symbioticProtocol.analyzeSystem(
        this.donorPath,
        this.systemName,
        this.correlationId,
      );

      // Step 2: Re-generate each recommended adapter
      let generatedCount = 0;
      for (const spec of analysis.recommendedAdapters) {
        const result = await this.symbioticProtocol.generateSidecarAdapter(
          spec,
          this.correlationId,
        );
        if (result.success) {
          generatedCount++;
        }
      }

      this.regenerationCount++;
      this.lastRegenerationAt = new Date().toISOString();

      this.logger.info('Regeneration cycle complete', {
        triggerFile,
        systemName: this.systemName,
        cycle: this.regenerationCount,
        analyzedModules: analysis.modulesAnalyzed,
        generatedAdapters: generatedCount,
        totalRecommended: analysis.recommendedAdapters.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Regeneration cycle failed', {
        triggerFile,
        donorPath: this.donorPath,
        error: message,
      });
    } finally {
      this.pendingRegeneration = false;
    }
  }
}
