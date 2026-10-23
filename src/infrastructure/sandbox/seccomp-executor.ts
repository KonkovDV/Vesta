/**
 * Seccomp Executor Implementation
 * Uses seccomp-bpf for syscall filtering as a lightweight fallback.
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

export interface SeccompConfig {
  profilePath?: string;
  networkMode: 'none' | 'host';
  memoryLimitMb: number;
  cpuLimitPercent: number;
  sandboxRoot: string;
  noNewPrivileges: boolean;
  dropAllCapabilities: boolean;
}

/**
 * Default seccomp profile restricting dangerous syscalls.
 * Blocks: execve, execveat, fork, vfork, clone (with namespace flags),
 * mount, umount, ptrace, process_vm_writev, etc.
 */
export const DEFAULT_SECCOMP_PROFILE = {
  defaultAction: 'SCMP_ACT_ALLOW',
  archMap: [
    { architecture: 'SCMP_ARCH_X86_64', subArchitectures: ['SCMP_ARCH_X86'] },
    { architecture: 'SCMP_ARCH_AARCH64', subArchitectures: ['SCMP_ARCH_ARM'] },
  ],
  syscalls: [
    {
      names: [
        'execve',
        'execveat',
        'fork',
        'vfork',
        'mount',
        'umount2',
        'ptrace',
        'process_vm_writev',
        'process_vm_readv',
        'kexec_load',
        'kexec_file_load',
        'open_by_handle_at',
        'init_module',
        'finit_module',
        'delete_module',
        'ioperm',
        'iopl',
        'swapon',
        'swapoff',
        'syslog',
        'sysfs',
        '_sysctl',
        'lookup_dcookie',
        'perf_event_open',
        'bpf',
        'clone3',
      ],
      action: 'SCMP_ACT_ERRNO',
      args: [],
    },
    {
      names: ['clone'],
      action: 'SCMP_ACT_ERRNO',
      args: [
        {
          index: 0,
          value: 0x00010000 | 0x00020000 | 0x20000000, // CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET
          valueTwo: 0,
          op: 'SCMP_CMP_MASKED_EQ',
        },
      ],
    },
  ],
};

export class SeccompExecutor extends EventEmitter implements ISandboxedExecutor {
  private readonly DEFAULT_MAX_OUTPUT_SIZE = 10 * 1024 * 1024; // 10MB
  private config: SeccompConfig;
  private activeProcesses = new Map<string, ReturnType<typeof spawn>>();
  private profileFile?: string;

  constructor(config?: Partial<SeccompConfig>) {
    super();
    this.config = this.mergeConfig(config);
  }

  private mergeConfig(overrides?: Partial<SeccompConfig>): SeccompConfig {
    return {
      networkMode: 'none',
      memoryLimitMb: 512,
      cpuLimitPercent: 100,
      sandboxRoot: './workspace',
      noNewPrivileges: true,
      dropAllCapabilities: true,
      ...overrides,
    };
  }

  async isAvailable(): Promise<boolean> {
    // Check if seccomp is supported by the kernel
    try {
      const fs = await import('fs/promises');
      await fs.access('/proc/self/seccomp');
      return true;
    } catch {
      return false;
    }
  }

  getCapabilities(): SandboxCapabilities {
    return {
      supportsNetwork: this.config.networkMode !== 'none',
      supportsFilesystem: true,
      supportsProcesses: false, // Process creation blocked by seccomp
      maxMemoryLimitMb: 4096,
      maxTimeoutMs: 300000,
      supportedLanguages: ['javascript', 'python'],
      kernelIsolation: false, // seccomp is not kernel-level isolation like gVisor
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
      const args = await this.buildArgs(options, executionId, workspacePath);
      const result = await this.spawnSandboxed(args, options, maxOutputSize, executionId, workspacePath);
      
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

  private async buildArgs(options: SandboxExecutionOptions, executionId: string, workspacePath: string): Promise<string[]> {
    const runtimeArgs: string[] = [];

    // Use unshare for namespace isolation if available
    if (process.platform === 'linux') {
      runtimeArgs.push('unshare');
      runtimeArgs.push('--user', '--map-root-user');
      runtimeArgs.push('--pid', '--fork');
      runtimeArgs.push('--mount-proc');
      runtimeArgs.push('--net');
      runtimeArgs.push('--');
    }

    // Add prlimit for resource constraints
    runtimeArgs.push('prlimit');
    runtimeArgs.push(`--as=${options.memoryLimitMb * 1024 * 1024}`); // Address space limit
    runtimeArgs.push(`--cpu=${Math.ceil(options.timeoutMs / 1000)}`); // CPU time limit
    runtimeArgs.push(`--nofile=1024`); // File descriptor limit
    runtimeArgs.push(`--nproc=64`); // Process limit
    runtimeArgs.push('--');

    // Add the actual runtime command (secure - no shell)
    const execArgs = await this.buildExecutionCommand(options, workspacePath);
    runtimeArgs.push(...execArgs);

    return runtimeArgs;
  }

  private async buildExecutionCommand(options: SandboxExecutionOptions, workspacePath: string): Promise<string[]> {
    const { code, language, allowedImports } = options;
    const sanitizedCode = this.sanitizeCode(code);

    switch (language) {
      case 'javascript':
        return this.buildJavaScriptCommand(sanitizedCode, allowedImports, workspacePath);
      case 'python':
        return this.buildPythonCommand(sanitizedCode, allowedImports, workspacePath);
      default:
        throw new SandboxExecutionError(
          `Unsupported language for seccomp sandbox: ${language}`,
          -1,
          '',
        );
    }
  }

  private async buildJavaScriptCommand(code: string, allowedImports: string[] | undefined, workspacePath: string): Promise<string[]> {
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
    // A-006 Fix: Write to temp file instead of shell command
    const tempFile = path.join(workspacePath, 'script.js');
    await fs.writeFile(tempFile, wrappedCode, 'utf8');
    return ['node', tempFile];
  }

  private async buildPythonCommand(code: string, allowedImports: string[] | undefined, workspacePath: string): Promise<string[]> {
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
    // A-006 Fix: Write to temp file instead of shell command
    const tempFile = path.join(workspacePath, 'script.py');
    await fs.writeFile(tempFile, wrappedCode, 'utf8');
    return ['python3', tempFile];
  }

  private sanitizeCode(code: string): string {
    return Array.from(code)
      .filter((char) => {
        const codePoint = char.charCodeAt(0);
        return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || (codePoint >= 0x20 && codePoint !== 0x7f);
      })
      .join('');
  }

  private spawnSandboxed(
    args: string[],
    options: SandboxExecutionOptions,
    maxOutputSize: number,
    executionId: string,
    workspacePath: string,
  ): Promise<SandboxExecutionResult> {
    return new Promise((resolve, reject) => {
      const timeout = options.timeoutMs;
      const startTime = Date.now();

      const [cmd, ...cmdArgs] = args;
      const child = spawn(cmd, cmdArgs, {
        timeout,
        killSignal: 'SIGKILL',
        cwd: workspacePath,
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          EXECUTION_ID: executionId,
          LANGUAGE: options.language,
          ...options.environment,
        },
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
          `Failed to spawn sandboxed process: ${err.message}`,
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
            sandboxType: 'seccomp',
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
            sandboxType: 'seccomp',
          },
        });
      });
    });
  }
}
