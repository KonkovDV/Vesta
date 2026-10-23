/**
 * IPlatformAdapter — Domain Port for cross-platform abstraction.
 *
 * Eliminates direct `process.platform` / `os.platform()` in Infrastructure layer.
 * All platform-specific decisions must flow through this port.
 *
 * @layer Domain
 * @phase Cross-Platform Compatibility V1
 * @pattern Strategy + Adapter (GoF)
 * @see PLANS/CROSS_PLATFORM_PLAN_V1.md — Phase 1
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Supported Node.js platform identifiers */
export type SupportedPlatform = 'win32' | 'linux' | 'darwin';

/** Supported CPU architectures */
export type SupportedArch = 'x64' | 'arm64' | 'arm' | 'ia32';

/** Shell configuration for executing commands on the current platform */
export interface PlatformShellConfig {
  /** Shell executable (e.g., 'cmd.exe', '/bin/sh') */
  readonly command: string;
  /** Shell arguments for executing a command string (e.g., ['/c'], ['-c']) */
  readonly args: readonly string[];
}

/** Platform-specific signal set for process management */
export interface PlatformSignalSet {
  /** Signals to forward when managing child processes */
  readonly signals: readonly NodeJS.Signals[];
}

/** Platform-specific process kill strategy */
export type ProcessKillStrategy = 'unix-signal' | 'win32-taskkill';

// ─── Port Interface ──────────────────────────────────────────────────────────

/**
 * Platform abstraction port.
 *
 * Provides platform-agnostic access to OS-specific behavior.
 * Infrastructure layer provides `NodePlatformAdapter` (real `process.platform`).
 * Tests can mock this to simulate any platform on any host OS.
 */
export interface IPlatformAdapter {
  /** Current platform identifier */
  getPlatform(): SupportedPlatform;

  /** Current CPU architecture */
  getArch(): SupportedArch;

  /** End-of-line character for the current platform */
  getEol(): string;

  /** Whether current platform is Windows */
  isWindows(): boolean;

  /** Whether current platform is Linux */
  isLinux(): boolean;

  /** Whether current platform is macOS */
  isDarwin(): boolean;

  /** Get shell configuration for command execution */
  getShell(): PlatformShellConfig;

  /** Path separator for current platform ('\\' on Windows, '/' on POSIX) */
  getPathSeparator(): string;

  /** PATH delimiter for current platform (';' on Windows, ':' on POSIX) */
  getPathDelimiter(): string;

  /** Get default signal set for child process bridge */
  getDefaultSignals(): PlatformSignalSet;

  /** Get process kill strategy for current platform */
  getProcessKillStrategy(): ProcessKillStrategy;

  /** Platform-specific null device path ('\\\\.\nul' on Windows, '/dev/null' on POSIX) */
  getDevNull(): string;

  /** Platform-specific temporary directory (wraps os.tmpdir()) */
  getTmpDir(): string;

  /** Current user's home directory (wraps os.homedir()) */
  getHomeDir(): string;
}
