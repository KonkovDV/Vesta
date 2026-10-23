/**
 * Sandboxed Executor Port
 * Domain layer contract for secure code execution environments.
 * Layer: Domain
 */

export type SandboxLanguage = 'javascript' | 'python' | 'wasm';

export interface SandboxExecutionOptions {
  code: string;
  language: SandboxLanguage;
  timeoutMs: number;
  memoryLimitMb: number;
  allowedImports?: string[];
  environment?: Record<string, string>;
  workingDir?: string;
  maxOutputSize?: number;
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  metadata: {
    executionId: string;
    timestamp: Date;
    sandboxType: string;
  };
}

export interface SandboxCapabilities {
  supportsNetwork: boolean;
  supportsFilesystem: boolean;
  supportsProcesses: boolean;
  maxMemoryLimitMb: number;
  maxTimeoutMs: number;
  supportedLanguages: SandboxLanguage[];
  kernelIsolation: boolean;
}

export interface ISandboxedExecutor {
  execute(options: SandboxExecutionOptions): Promise<SandboxExecutionResult>;
  isAvailable(): Promise<boolean>;
  getCapabilities(): SandboxCapabilities;
}

export class SandboxExecutionError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
    public readonly executionId?: string,
  ) {
    super(message);
    this.name = 'SandboxExecutionError';
  }
}

export class SandboxTimeoutError extends Error {
  constructor(
    message: string,
    public readonly timeoutMs: number,
    public readonly executionId?: string,
  ) {
    super(message);
    this.name = 'SandboxTimeoutError';
  }
}

export class SandboxResourceLimitError extends Error {
  constructor(
    message: string,
    public readonly limitType: 'memory' | 'output' | 'cpu',
    public readonly limitValue: number,
    public readonly executionId?: string,
  ) {
    super(message);
    this.name = 'SandboxResourceLimitError';
  }
}
