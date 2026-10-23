/**
 * NodePlatformAdapter — Infrastructure implementation of IPlatformAdapter.
 *
 * Wraps Node.js `process.platform`, `os.EOL`, `path.sep`, etc.
 * Registered as singleton — immutable at runtime (platform doesn't change).
 *
 * @layer Infrastructure (Platform)
 * @phase Cross-Platform Compatibility V1
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import type {
  IPlatformAdapter,
  PlatformShellConfig,
  PlatformSignalSet,
  ProcessKillStrategy,
  SupportedArch,
  SupportedPlatform,
} from '../../domain/platform/IPlatformAdapter';

function assertSupportedPlatform(platform: string): SupportedPlatform {
  if (platform === 'win32' || platform === 'linux' || platform === 'darwin') {
    return platform;
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

export class NodePlatformAdapter implements IPlatformAdapter {
  private readonly platform: SupportedPlatform;
  private readonly arch: SupportedArch;

  constructor() {
    this.platform = assertSupportedPlatform(process.platform);
    this.arch = process.arch as SupportedArch;
  }

  getPlatform(): SupportedPlatform {
    return this.platform;
  }

  getArch(): SupportedArch {
    return this.arch;
  }

  getEol(): string {
    return os.EOL;
  }

  isWindows(): boolean {
    return this.platform === 'win32';
  }

  isLinux(): boolean {
    return this.platform === 'linux';
  }

  isDarwin(): boolean {
    return this.platform === 'darwin';
  }

  getShell(): PlatformShellConfig {
    if (this.platform === 'win32') {
      return { command: 'cmd.exe', args: ['/c'] };
    }
    return { command: '/bin/sh', args: ['-c'] };
  }

  getPathSeparator(): string {
    return path.sep;
  }

  getPathDelimiter(): string {
    return path.delimiter;
  }

  getDefaultSignals(): PlatformSignalSet {
    if (this.platform === 'win32') {
      return { signals: ['SIGTERM', 'SIGINT', 'SIGBREAK'] };
    }
    return { signals: ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] };
  }

  getProcessKillStrategy(): ProcessKillStrategy {
    return this.platform === 'win32' ? 'win32-taskkill' : 'unix-signal';
  }

  getDevNull(): string {
    return os.devNull;
  }

  getTmpDir(): string {
    return os.tmpdir();
  }

  getHomeDir(): string {
    return os.homedir();
  }
}
