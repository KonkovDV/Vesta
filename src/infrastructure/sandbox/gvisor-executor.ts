/**
 * gVisor Executor Implementation
 * Uses runsc (gVisor) for OCI container sandboxing with kernel-level isolation.
 * Layer: Infrastructure
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ISandboxedExecutor,
  SandboxExecutionOptions,
  SandboxExecutionResult,
  SandboxCapabilities,
  SandboxExecutionError,
  SandboxTimeoutError,
  SandboxResourceLimitError,
  SandboxLanguage,
} from '../../domain/sandbox/sandboxed-executor.port';
import { SandboxRuntimeSchema, SandboxRuntimeConfig } from '../../config/schema/definitions/sandbox.schema';

export interface GVisorConfig {
  platform: 'ptrace' | 'kvm';
  debug: boolean;
  strace: boolean;
  networkMode: 'none' | 'host' | 'bridge';
  memoryLimitMb: number;
  pidsLimit: number;
  sandboxRoot: string;
  containerImage: string;
}

/** Minimal logger contract for GVisorExecutor (defaults to console). */
export interface GVisorLogger {
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
}

export class GVisorExecutor extends EventEmitter implements ISandboxedExecutor {
  private readonly DEFAULT_MAX_OUTPUT_SIZE = 10 * 1024 * 1024; // 10MB
  private readonly DEFAULT_IMAGE = 'sandbox-runtime:latest';
  private readonly WORKSPACE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly WORKSPACE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  private config: GVisorConfig;
  private activeProcesses = new Map<string, ReturnType<typeof spawn>>();
  private cleanupInterval?: ReturnType<typeof setInterval>;
  private readonly logger: GVisorLogger;

  constructor(config?: Partial<GVisorConfig>, logger?: GVisorLogger) {
    super();
    this.config = this.mergeConfig(config);
    this.logger = logger ?? console;
    // A-025 FIX: Start periodic cleanup of orphaned workspaces
    this.startPeriodicCleanup();
  }

  /**
   * A-025 FIX: Periodically clean up orphaned workspace directories
   * that may be left behind if the process crashed during execution.
   */
  private startPeriodicCleanup(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanupOrphanedWorkspaces();
      } catch (error) {
        this.logger.error('[GVisorExecutor] Periodic workspace cleanup failed:', error);
      }
    }, this.WORKSPACE_CLEANUP_INTERVAL_MS);

    // Ensure cleanup doesn't prevent process exit
    if (this.cleanupInterval && typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Clean up workspace directories older than WORKSPACE_MAX_AGE_MS
   */
  private async cleanupOrphanedWorkspaces(): Promise<void> {
    const workspaceRoot = this.config.sandboxRoot;

    try {
      const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
      const now = Date.now();
      let cleanedCount = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Skip if it's an active execution workspace
        if (this.activeProcesses.has(entry.name)) continue;

        const workspacePath = path.join(workspaceRoot, entry.name);

        try {
          const stats = await fs.stat(workspacePath);
          const ageMs = now - stats.mtime.getTime();

          if (ageMs > this.WORKSPACE_MAX_AGE_MS) {
            await fs.rm(workspacePath, { recursive: true, force: true });
            cleanedCount++;
            this.emit('workspace:cleaned', { executionId: entry.name, ageMs });
          }
        } catch (statError) {
          // Ignore errors for individual directories (may be in use)
          this.logger.warn('[GVisorExecutor] Could not stat workspace during cleanup:', {
            workspacePath,
            error: (statError as Error).message,
          });
        }
      }

      if (cleanedCount > 0) {
        this.logger.info(`[GVisorExecutor] Cleaned up ${cleanedCount} orphaned workspace(s)`);
      }
    } catch (error) {
      // Directory may not exist yet
      this.logger.warn('[GVisorExecutor] Could not read workspace root for cleanup:', {
        workspaceRoot,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Stop the periodic cleanup interval. Should be called during graceful shutdown.
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  private mergeConfig(overrides?: Partial<GVisorConfig>): GVisorConfig {
    const defaults = {
      platform: 'kvm',
      debug: false,
      strace: false,
      networkMode: 'none',
      memoryLimitMb: 512,
      pidsLimit: 64,
      sandboxRoot: './workspace',
      containerImage: this.DEFAULT_IMAGE,
    };
    
    // Merge and Validate via Zod
    const merged = { ...defaults, ...overrides };
    
    // This will throw if paths are unsafe (../../etc)
    // This will throw if paths are unsafe (../../etc)
    const result = SandboxRuntimeSchema.safeParse(merged);
    
    if (!result.success) {
        throw new Error(`Invalid Sandbox Configuration: ${result.error.message}`);
    }

    const typedResult = result.data;
    
    // Map nested config back to flat GVisorConfig structure for backward compatibility
    return {
        platform: typedResult.provider === 'gvisor' ? typedResult.gvisor.platform : 'kvm',
        debug: typedResult.provider === 'gvisor' ? typedResult.gvisor.debug : false,
        strace: typedResult.provider === 'gvisor' ? typedResult.gvisor.strace : false,
        networkMode: typedResult.network.mode,
        memoryLimitMb: typedResult.limits.memoryLimitMb,
        pidsLimit: typedResult.limits.pidsLimit,
        sandboxRoot: typedResult.filesystem.sandboxRoot,
        containerImage: 'sandbox-runtime:latest', // Not in schema currently, keeping default
    };
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('runsc', ['--version'], { timeout: 5000 });
      let available = false;

      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
      proc.on('exit', () => resolve(available));

      proc.stdout?.on('data', () => { available = true; });
    });
  }

  getCapabilities(): SandboxCapabilities {
    return {
      supportsNetwork: this.config.networkMode !== 'none',
      supportsFilesystem: true,
      supportsProcesses: false, // Container isolation, no process escape
      maxMemoryLimitMb: 8192,
      maxTimeoutMs: 300000, // 5 minutes
      supportedLanguages: ['javascript', 'python', 'wasm'],
      kernelIsolation: true,
    };
  }

  async execute(options: SandboxExecutionOptions): Promise<SandboxExecutionResult> {
    const executionId = randomUUID();
    const workspacePath = path.join(this.config.sandboxRoot, executionId);
    const maxOutputSize = options.maxOutputSize ?? this.DEFAULT_MAX_OUTPUT_SIZE;
    const startTime = Date.now();

    this.emit('execution:started', { executionId, language: options.language });

    // Create unique workspace for this execution
    await fs.mkdir(workspacePath, { recursive: true });

    try {
      // Write code to file and get execution command (no shell)
      const execCommand = await this.prepareExecution(workspacePath, options);
      const runscArgs = this.buildRunscArgs(options, executionId, workspacePath, execCommand);
      const result = await this.spawnRunsc(runscArgs, options, maxOutputSize, executionId);
      
      this.emit('execution:completed', {
        executionId,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
      });

      return result;
    } catch (error) {
      this.emit('execution:failed', { executionId, error });
      throw error;
    } finally {
      // Cleanup workspace
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  }

  private async prepareExecution(
    workspacePath: string,
    options: SandboxExecutionOptions,
  ): Promise<string[]> {
    const { code, language, allowedImports } = options;
    const sanitizedCode = this.sanitizeCode(code);

    switch (language) {
      case 'javascript':
        return this.prepareJavaScriptExecution(workspacePath, sanitizedCode, allowedImports);
      case 'python':
        return this.preparePythonExecution(workspacePath, sanitizedCode, allowedImports);
      case 'wasm':
        return this.prepareWasmExecution(workspacePath, sanitizedCode);
      default:
        throw new SandboxExecutionError(
          'Unsupported language',
          -1,
          '',
        );
    }
  }

  private async prepareJavaScriptExecution(
    workspacePath: string,
    code: string,
    allowedImports?: string[],
  ): Promise<string[]> {
    const scriptPath = path.join(workspacePath, 'script.js');
    
    const importRestriction = allowedImports 
      ? `const ALLOWED_IMPORTS = ${JSON.stringify(allowedImports)};`
      : 'const ALLOWED_IMPORTS = [];';

    const wrappedCode = `
${importRestriction}
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (ALLOWED_IMPORTS.length > 0 && !ALLOWED_IMPORTS.includes(id)) {
    throw new Error(\`Import '\${id}' is not allowed\`);
  }
  return originalRequire.apply(this, arguments);
};

try {
  ${code}
} catch (err) {
  console.error(err);
  process.exit(1);
}
`;
    await fs.writeFile(scriptPath, wrappedCode, 'utf8');
    return ['node', '/workspace/script.js'];
  }

  private async preparePythonExecution(
    workspacePath: string,
    code: string,
    allowedImports?: string[],
  ): Promise<string[]> {
    const scriptPath = path.join(workspacePath, 'script.py');
    
    const importRestriction = allowedImports
      ? `ALLOWED_IMPORTS = ${JSON.stringify(allowedImports)}`
      : 'ALLOWED_IMPORTS = []';

    const wrappedCode = `
import sys
import builtins
${importRestriction}

__original_import = builtins.__import__
def __restricted_import(name, *args, **kwargs):
    if ALLOWED_IMPORTS and name not in ALLOWED_IMPORTS:
        raise ImportError(f"Import '{name}' is not allowed")
    return __original_import(name, *args, **kwargs)
builtins.__import__ = __restricted_import

try:
${code.split('\n').map(line => '    ' + line).join('\n')}
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;
    await fs.writeFile(scriptPath, wrappedCode, 'utf8');
    return ['python3', '/workspace/script.py'];
  }

  private async prepareWasmExecution(
    workspacePath: string,
    code: string,
  ): Promise<string[]> {
    // For WASM, code is expected to be base64-encoded WASM binary
    const wasmPath = path.join(workspacePath, 'app.wasm');
    const wasmBinary = Buffer.from(code, 'base64');
    await fs.writeFile(wasmPath, wasmBinary);
    return ['wasmtime', '/workspace/app.wasm'];
  }

  private buildRunscArgs(
    options: SandboxExecutionOptions,
    executionId: string,
    workspacePath: string,
    execCommand: string[],
  ): string[] {
    const args: string[] = [
      `--platform=${this.config.platform}`,
    ];

    if (this.config.debug) args.push('--debug');
    if (this.config.strace) args.push('--strace');

    args.push(
      'run',
      '--rm',
      `--network=${this.config.networkMode}`,
      `--memory=${options.memoryLimitMb}m`,
      `--pids-limit=${this.config.pidsLimit}`,
      '--cpus=1',
      '--security-opt=no-new-privileges:true',
      '--cap-drop=ALL',
      '-v', `${workspacePath}:/workspace:rw`,
      '-e', `EXECUTION_ID=${executionId}`,
      '-e', `LANGUAGE=${options.language}`,
      '-w', '/workspace',
    );

    // Add environment variables
    if (options.environment) {
      for (const [key, value] of Object.entries(options.environment)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // Add readonly mounts for security
    args.push(
      '-v', '/etc/hosts:/etc/hosts:ro',
      '-v', '/etc/resolv.conf:/etc/resolv.conf:ro',
    );

    args.push(this.config.containerImage);

    // Append execution command directly (no shell)
    args.push(...execCommand);

    return args.filter(Boolean);
  }

  private sanitizeCode(code: string): string {
    // Basic sanitization - remove null bytes and control characters
    return Array.from(code)
      .filter((char) => {
        const codePoint = char.charCodeAt(0);
        return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint >= 0x20;
      })
      .join('');
  }

  private spawnRunsc(
    args: string[],
    options: SandboxExecutionOptions,
    maxOutputSize: number,
    executionId: string,
  ): Promise<SandboxExecutionResult> {
    return new Promise((resolve, reject) => {
      const timeout = options.timeoutMs;
      const startTime = Date.now();

      const child = spawn('runsc', args, {
        timeout,
        killSignal: 'SIGKILL',
      });

      this.activeProcesses.set(executionId, child);

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let killedForSize = false;

      const cleanup = () => {
        this.activeProcesses.delete(executionId);
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      };

      const checkOutputLimit = (currentSize: number): boolean => {
        if (currentSize > maxOutputSize && !killedForSize) {
          killedForSize = true;
          truncated = true;
          cleanup();
          return false;
        }
        return true;
      };

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;

        if (!checkOutputLimit(stdout.length)) {
          stdout = stdout.substring(0, maxOutputSize) +
            `\n...[TRUNCATED: Output exceeded ${maxOutputSize / 1024 / 1024}MB limit]`;
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;

        if (!checkOutputLimit(stderr.length)) {
          stderr = stderr.substring(0, maxOutputSize) +
            `\n...[TRUNCATED: Error output exceeded limit]`;
        }
      });

      child.on('error', (err: Error) => {
        cleanup();
        reject(new SandboxExecutionError(
          `Failed to spawn gVisor: ${err.message}`,
          -1,
          stderr,
          executionId,
        ));
      });

      child.on('close', (code: number | null, signal: string | null) => {
        cleanup();
        const durationMs = Date.now() - startTime;

        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          if (killedForSize) {
            reject(new SandboxResourceLimitError(
              `Output exceeded maximum size of ${maxOutputSize} bytes`,
              'output',
              maxOutputSize,
              executionId,
            ));
          } else {
            reject(new SandboxTimeoutError(
              `Execution timed out after ${timeout}ms`,
              timeout,
              executionId,
            ));
          }
          return;
        }

        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
          durationMs,
          truncated,
          metadata: {
            executionId,
            timestamp: new Date(),
            sandboxType: 'gvisor',
          },
        });
      });
    });
  }

  async killAll(): Promise<void> {
    const kills = Array.from(this.activeProcesses.entries()).map(
      async ([id, proc]) => {
        this.emit('process:killing', { executionId: id, pid: proc.pid });
        
        proc.kill('SIGTERM');
        
        await new Promise<void>((resolve) => {
          const forceKillTimeout = setTimeout(() => {
            if (!proc.killed) {
              this.emit('process:force-kill', { executionId: id, pid: proc.pid });
              proc.kill('SIGKILL');
            }
            resolve();
          }, 5000);
          
          proc.on('exit', () => {
            clearTimeout(forceKillTimeout);
            resolve();
          });
        });
        
        this.activeProcesses.delete(id);
        this.emit('process:killed', { executionId: id });
      }
    );
    
    await Promise.allSettled(kills);
  }

  async executeCommand(
    command: string,
    args: string[],
    options?: {
      timeoutMs?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      input?: string;
      maxOutputSize?: number;
    },
  ): Promise<SandboxExecutionResult> {
    const executionId = randomUUID();
    const maxOutputSize = options?.maxOutputSize ?? this.DEFAULT_MAX_OUTPUT_SIZE;
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const hasInput = Boolean(options?.input);
      const child = spawn(command, args, {
        shell: false,
        stdio: hasInput ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
        timeout: options?.timeoutMs,
        killSignal: 'SIGKILL',
      });

      this.activeProcesses.set(executionId, child);

      if (hasInput) {
        child.stdin?.end(options!.input);
      }

      let stdout = '';
      let stderr = '';
      let truncated = false;

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > maxOutputSize) {
          truncated = true;
          stdout = stdout.substring(0, maxOutputSize);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (err: Error) => {
        this.activeProcesses.delete(executionId);
        reject(new SandboxExecutionError(err.message, -1, stderr, executionId));
      });

      child.on('close', (code: number | null) => {
        this.activeProcesses.delete(executionId);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
          durationMs: Date.now() - startTime,
          truncated,
          metadata: {
            executionId,
            timestamp: new Date(),
            sandboxType: 'gvisor',
          },
        });
      });
    });
  }
}
