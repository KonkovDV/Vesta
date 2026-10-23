/**
 * System Integrity Checker
 * Layer: Core/Bootstrap
 *
 * Provides interfaces and base classes for pre-flight system checks.
 * Ensures the application starts in a known-good state.
 */

type IntegrityLogger = {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  child?: (scope?: unknown) => IntegrityLogger;
};

export interface CheckResult {
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

export type CheckSeverity = 'critical' | 'warning' | 'info';

export interface IntegrityCheck {
  name: string;
  description: string;
  check(): Promise<CheckResult>;
  priority: number; // Lower = more critical (1-100)
  severity: CheckSeverity;
  timeoutMs: number;
}

export interface BootstrapResult {
  success: boolean;
  checks: CheckReport[];
  durationMs: number;
  failedCritical: string[];
  failedWarnings: string[];
}

export interface CheckReport {
  name: string;
  passed: boolean;
  severity: CheckSeverity;
  message: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export abstract class BaseIntegrityCheck implements IntegrityCheck {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly priority: number;
  abstract readonly severity: CheckSeverity;
  readonly timeoutMs: number = 5000;

  protected async runWithTimeout<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const timeout = timeoutMs ?? this.timeoutMs;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Check timed out after ${timeout}ms`)), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer!); // KI-006: prevent timer leak
    }
  }

  abstract check(): Promise<CheckResult>;

  protected pass(message: string, details?: Record<string, unknown>): CheckResult {
    return { passed: true, message, details };
  }

  protected fail(message: string, details?: Record<string, unknown>): CheckResult {
    return { passed: false, message, details };
  }
}

export class SystemIntegrityChecker {
  private checks: IntegrityCheck[] = [];
  private readonly logger: IntegrityLogger;

  constructor(logger?: IntegrityLogger) {
    this.logger = logger ?? {
      debug: (msg, meta) => console.debug(msg, meta),
      info: (msg, meta) => console.info(msg, meta),
      warn: (msg, meta) => console.warn(msg, meta),
      error: (msg, meta) => console.error(msg, meta),
      child: () => this.logger,
    };
  }

  register(check: IntegrityCheck): void {
    this.checks.push(check);
    // Sort by priority (lower = more critical)
    this.checks.sort((a, b) => a.priority - b.priority);
  }

  registerMany(checks: IntegrityCheck[]): void {
    for (const check of checks) {
      this.register(check);
    }
  }

  async runAll(): Promise<BootstrapResult> {
    const startedAt = process.hrtime.bigint();
    const reports: CheckReport[] = [];
    const failedCritical: string[] = [];
    const failedWarnings: string[] = [];

    this.logger.info(`[SystemIntegrity] Starting ${this.checks.length} integrity checks`);

    for (const check of this.checks) {
      const checkStart = process.hrtime.bigint();
      let report: CheckReport;

      try {
        const result = await this.runCheckWithTimeout(check);
        const durationMs = Number(process.hrtime.bigint() - checkStart) / 1e6;

        report = {
          name: check.name,
          passed: result.passed,
          severity: check.severity,
          message: result.message,
          durationMs,
          details: result.details,
        };

        if (!result.passed) {
          if (check.severity === 'critical') {
            failedCritical.push(check.name);
            this.logger.error(`[SystemIntegrity] CRITICAL check failed: ${check.name}`, {
              message: result.message,
              durationMs,
            });
          } else if (check.severity === 'warning') {
            failedWarnings.push(check.name);
            this.logger.warn(`[SystemIntegrity] Warning check failed: ${check.name}`, {
              message: result.message,
              durationMs,
            });
          }
        } else {
          this.logger.info(`[SystemIntegrity] ✓ ${check.name} passed (${durationMs.toFixed(2)}ms)`);
        }
      } catch (error) {
        const durationMs = Number(process.hrtime.bigint() - checkStart) / 1e6;
        const errorMessage = error instanceof Error ? error.message : String(error);

        report = {
          name: check.name,
          passed: false,
          severity: check.severity,
          message: `Check threw exception: ${errorMessage}`,
          durationMs,
        };

        if (check.severity === 'critical') {
          failedCritical.push(check.name);
        } else if (check.severity === 'warning') {
          failedWarnings.push(check.name);
        }

        this.logger.error(`[SystemIntegrity] Check ${check.name} threw exception`, {
          error: errorMessage,
          durationMs,
        });
      }

      reports.push(report);
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const success = failedCritical.length === 0;

    this.logger.info(`[SystemIntegrity] Checks completed in ${durationMs.toFixed(2)}ms`, {
      total: this.checks.length,
      passed: reports.filter(r => r.passed).length,
      failed: reports.filter(r => !r.passed).length,
      failedCritical: failedCritical.length,
      failedWarnings: failedWarnings.length,
    });

    return {
      success,
      checks: reports,
      durationMs,
      failedCritical,
      failedWarnings,
    };
  }

  private async runCheckWithTimeout(check: IntegrityCheck): Promise<CheckResult> {
    const checkStart = process.hrtime.bigint();
    const result = await check.check();
    const durationMs = Number(process.hrtime.bigint() - checkStart) / 1e6;
    return { ...result, durationMs };
  }

  getRegisteredChecks(): IntegrityCheck[] {
    return [...this.checks];
  }

  clear(): void {
    this.checks = [];
  }
}

export function createIntegrityChecker(): SystemIntegrityChecker {
  return new SystemIntegrityChecker();
}
