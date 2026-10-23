/**
 * IIncrementalMdcCompiler — Domain Port for Incremental MDC Compilation
 *
 * Extends MdcCompiler with dirty-tracking using file system watchers.
 * Only re-compiles MDC files whose content hash has changed, dramatically
 * reducing compilation overhead for large rule sets.
 *
 * Architecture:
 *   IIncrementalMdcCompiler (port) ← IncrementalMdcCompilerAdapter (infra)
 *     ← MdcCompiler (existing) + fs.watch() (file system watcher)
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @horizon Horizon 2 — Context Engineering: Incremental Compilation
 * @pattern REC-089-04 Incremental MDC Compilation
 */

// ── Dirty Tracking State ──────────────────────────────────────────

/** Status of a single MDC file in the compile cache. */
export type MdcFileStatus = 'clean' | 'dirty' | 'compiling' | 'error';

/** Per-file compilation state. */
export interface MdcFileState {
  /** MDC file name (without extension). */
  readonly name: string;
  /** Current status. */
  readonly status: MdcFileStatus;
  /** SHA-256 hash of last compiled content. */
  readonly lastHash: string;
  /** ISO timestamp of last compilation. */
  readonly lastCompiledAt: string;
  /** Number of times compiled since watcher start. */
  readonly compilationCount: number;
}

/** Summary of incremental compilation state. */
export interface IncrementalCompilationStats {
  /** Total MDC files tracked. */
  readonly totalFiles: number;
  /** Files currently clean (no changes). */
  readonly cleanFiles: number;
  /** Files marked dirty (awaiting re-compilation). */
  readonly dirtyFiles: number;
  /** Whether file watcher is active. */
  readonly watcherActive: boolean;
  /** Total compilation cache hits. */
  readonly cacheHits: number;
  /** Total compilation cache misses. */
  readonly cacheMisses: number;
}

// ── Port Interface ────────────────────────────────────────────────

/**
 * IIncrementalMdcCompiler — MDC compilation with dirty-tracking.
 *
 * Wraps the existing MdcCompiler and adds file-system watcher integration
 * to only re-compile changed files.
 */
export interface IIncrementalMdcCompiler {
  /**
   * Start watching MDC files for changes.
   * Files modified after watch starts are marked dirty and re-compiled
   * on the next compile() or compileAll() call.
   */
  startWatching(): void;

  /**
   * Stop watching MDC files.
   */
  stopWatching(): void;

  /**
   * Check if a specific MDC file needs re-compilation.
   */
  isDirty(mdcName: string): boolean;

  /**
   * Get compilation state for all tracked files.
   */
  getFileStates(): readonly MdcFileState[];

  /**
   * Get compilation statistics.
   */
  getStats(): IncrementalCompilationStats;

  /**
   * Mark a file as dirty (e.g., after external modification notification).
   */
  markDirty(mdcName: string): void;

  /**
   * Force re-compilation of all files regardless of dirty state.
   */
  forceRecompileAll(): void;
}
