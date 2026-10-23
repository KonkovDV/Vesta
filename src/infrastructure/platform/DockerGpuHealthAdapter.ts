import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';
import type {
  GpuDeviceInfo,
  GpuHealthReport,
  IGpuHealthMonitor,
} from '../../domain/platform/IGpuHealthMonitor';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
export interface DockerExecResult {
  stdout: string;
  stderr: string;
}

export type DockerCommandExecutor = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<DockerExecResult>;

interface DockerGpuHealthAdapterDeps {
  executor?: DockerCommandExecutor;
  logger?: Pick<IStructuredLogger, 'warn' | 'error' | 'debug'>;
  timeoutMs?: number;
}

export class DockerGpuHealthAdapter implements IGpuHealthMonitor {
  private readonly executor: DockerCommandExecutor;
  private readonly logger?: Pick<IStructuredLogger, 'warn' | 'error' | 'debug'>;
  private readonly timeoutMs: number;

  constructor(deps: DockerGpuHealthAdapterDeps = {}) {
    this.executor = deps.executor ?? defaultDockerExecutor;
    this.logger = deps.logger;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async checkHealth(containerName: string): Promise<GpuHealthReport> {
    try {
      const result = await this.executor(
        'docker',
        buildGpuArgs(containerName),
        { timeoutMs: this.timeoutMs },
      );

      const combinedOutput = sanitizeOutput(`${result.stdout}\n${result.stderr}`);
      if (isUnavailableOutput(combinedOutput)) {
        return buildReport(containerName, 'unavailable', [], combinedOutput || 'GPU runtime unavailable');
      }

      const gpus = parseGpuOutput(result.stdout);
      if (gpus.length === 0) {
        return buildReport(containerName, 'error', [], 'Malformed nvidia-smi output');
      }

      return {
        status: 'healthy',
        available: true,
        gpus,
        checkedAt: new Date(),
        containerName,
      };
    } catch (error) {
      const details = extractErrorDetails(error);
      if (isUnavailableOutput(details)) {
        this.logger?.warn?.('[DockerGpuHealthAdapter] GPU runtime unavailable', {
          containerName,
          error: details,
        });
        return buildReport(containerName, 'unavailable', [], details);
      }

      this.logger?.error?.('[DockerGpuHealthAdapter] GPU probe failed', {
        containerName,
        error: details,
      });
      return buildReport(containerName, 'error', [], details || 'GPU probe failed');
    }
  }
}

function buildGpuArgs(containerName: string): string[] {
  return [
    'exec',
    containerName,
    'nvidia-smi',
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits',
  ];
}

function sanitizeOutput(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint < 0 || codePoint > 8;
    })
    .join('')
    .trim();
}

function parseGpuOutput(output: string): GpuDeviceInfo[] {
  const cleaned = sanitizeOutput(output);
  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(',').map((part) => part.trim());
      if (parts.length < 2) {
        throw new Error('Malformed nvidia-smi output');
      }

      const memoryMb = parseInt(parts[1], 10);
      if (!Number.isFinite(memoryMb)) {
        throw new Error('Malformed nvidia-smi output');
      }

      return {
        vendor: 'NVIDIA',
        model: parts[0] || 'NVIDIA GPU',
        memoryMb,
      };
    });
}

function isUnavailableOutput(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    'not found',
    'enoent',
    'no devices were found',
    'failed to initialize nvml',
    'could not select device driver',
    'nvidia-container-runtime',
  ].some((marker) => normalized.includes(marker));
}

function extractErrorDetails(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const parts: string[] = [];
  const maybeError = error as { message?: unknown; stderr?: unknown; stdout?: unknown; code?: unknown };
  if (typeof maybeError.message === 'string' && maybeError.message.trim()) {
    parts.push(maybeError.message.trim());
  }
  if (typeof maybeError.stderr === 'string' && maybeError.stderr.trim()) {
    parts.push(maybeError.stderr.trim());
  }
  if (typeof maybeError.stdout === 'string' && maybeError.stdout.trim()) {
    parts.push(maybeError.stdout.trim());
  }
  if (parts.length === 0 && maybeError.code) {
    parts.push(String(maybeError.code));
  }
  return sanitizeOutput(parts.join('\n'));
}

function buildReport(
  containerName: string,
  status: 'unavailable' | 'error',
  gpus: GpuDeviceInfo[],
  error: string,
): GpuHealthReport {
  return {
    status,
    available: false,
    gpus,
    checkedAt: new Date(),
    containerName,
    error,
  };
}

async function defaultDockerExecutor(
  command: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<DockerExecResult> {
  const result = await execFileAsync(command, args, {
    timeout: options.timeoutMs,
    windowsHide: true,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}