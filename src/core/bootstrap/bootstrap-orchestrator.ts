/**
 * Bootstrap Orchestrator with System Integrity Checks
 * Layer: Core/Bootstrap
 *
 * Runs pre-flight integrity checks before starting the application.
 * Ensures system starts in a known-good state.
 */

import { SystemIntegrityChecker, BootstrapResult, CheckReport } from './system-integrity-checker';
import {
  EnvironmentCheck,
  ConfigCheck,
  FileSystemCheck,
  DatabaseCheck,
  RedisCheck,
  SecurityCheck,
} from './checks';
import { getOrCreateCounter, getOrCreateHistogram } from '../../monitoring';

// Bootstrap metrics
const bootstrapChecksTotal = getOrCreateCounter(
  'bootstrap_checks_total',
  'Total number of bootstrap checks run',
  ['check_name', 'status']
);

const bootstrapChecksDuration = getOrCreateHistogram(
  'bootstrap_checks_duration_seconds',
  'Duration of bootstrap checks in seconds',
  ['check_name'],
  [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
);

const bootstrapSuccess = getOrCreateCounter(
  'bootstrap_success_total',
  'Total number of successful bootstraps'
);

const bootstrapFailures = getOrCreateCounter(
  'bootstrap_failures_total',
  'Total number of failed bootstraps',
  ['reason']
);

export interface BootstrapOrchestratorOptions {
  skipChecks?: string[];
  additionalChecks?: string[];
  failOnWarning?: boolean;
  timeoutMs?: number;
}

export interface BootstrapOrchestratorResult {
  success: boolean;
  canContinue: boolean;
  result: BootstrapResult;
  criticalFailures: string[];
  warnings: string[];
}

export class BootstrapOrchestrator {
  private checker: SystemIntegrityChecker;
  private options: BootstrapOrchestratorOptions;

  constructor(options: BootstrapOrchestratorOptions = {}) {
    this.options = {
      failOnWarning: false,
      timeoutMs: 30000,
      ...options,
    };
    this.checker = new SystemIntegrityChecker();
    this.registerDefaultChecks();
  }

  private registerDefaultChecks(): void {
    // Priority 1-5: Critical infrastructure
    this.checker.register(new EnvironmentCheck());
    this.checker.register(new ConfigCheck());
    this.checker.register(new FileSystemCheck());

    // Priority 10-15: External services
    this.checker.register(new DatabaseCheck());
    this.checker.register(new RedisCheck());

    // Priority 20+: Security and non-critical
    this.checker.register(new SecurityCheck());
  }

  async bootstrap(): Promise<BootstrapOrchestratorResult> {
    const result = await this.checker.runAll();

    // Record metrics for each check
    for (const check of result.checks) {
      const status = check.passed ? 'passed' : 'failed';
      bootstrapChecksTotal.inc({ check_name: check.name, status });
      bootstrapChecksDuration.observe(
        { check_name: check.name },
        check.durationMs / 1000
      );
    }

    // Determine if we can continue
    const criticalFailures = result.failedCritical;
    const hasCriticalFailures = criticalFailures.length > 0;
    const hasWarnings = result.failedWarnings.length > 0;

    // Build detailed report
    const report = this.buildReport(result);

    // Log results
    this.logResults(result, report);

    if (hasCriticalFailures) {
      bootstrapFailures.inc({ reason: 'critical_check_failed' });
      return {
        success: false,
        canContinue: false,
        result,
        criticalFailures,
        warnings: result.failedWarnings,
      };
    }

    if (hasWarnings && this.options.failOnWarning) {
      bootstrapFailures.inc({ reason: 'warning_check_failed' });
      return {
        success: false,
        canContinue: false,
        result,
        criticalFailures: [],
        warnings: result.failedWarnings,
      };
    }

    bootstrapSuccess.inc();
    return {
      success: true,
      canContinue: true,
      result,
      criticalFailures: [],
      warnings: result.failedWarnings,
    };
  }

  private buildReport(result: BootstrapResult): string {
    const lines: string[] = [];
    lines.push('');
    lines.push('╔══════════════════════════════════════════════════════════╗');
    lines.push('║              BOOTSTRAP INTEGRITY REPORT                  ║');
    lines.push('╠══════════════════════════════════════════════════════════╣');
    lines.push(`║  Duration: ${result.durationMs.toFixed(2).padEnd(47)}ms ║`);
    lines.push(`║  Checks:   ${result.checks.length.toString().padEnd(47)}   ║`);
    lines.push(`║  Passed:   ${result.checks.filter(c => c.passed).length.toString().padEnd(47)}   ║`);
    lines.push(`║  Failed:   ${result.checks.filter(c => !c.passed).length.toString().padEnd(47)}   ║`);
    lines.push('╠══════════════════════════════════════════════════════════╣');

    for (const check of result.checks) {
      const status = check.passed ? '✓' : check.severity === 'critical' ? '✗' : '⚠';
      const duration = `${check.durationMs.toFixed(1)}ms`.padStart(8);
      const name = check.name.padEnd(20);
      lines.push(`║  ${status} ${name} ${duration}  ${check.severity.padEnd(10)} ║`);
    }

    if (result.failedCritical.length > 0) {
      lines.push('╠══════════════════════════════════════════════════════════╣');
      lines.push('║  CRITICAL FAILURES:                                      ║');
      for (const failure of result.failedCritical) {
        const check = result.checks.find(c => c.name === failure);
        const msg = check ? check.message.substring(0, 48) : /* istanbul ignore next */ failure;
        lines.push(`║    ✗ ${msg.padEnd(50)} ║`);
      }
    }

    if (result.failedWarnings.length > 0) {
      lines.push('╠══════════════════════════════════════════════════════════╣');
      lines.push('║  WARNINGS:                                               ║');
      for (const warning of result.failedWarnings) {
        const check = result.checks.find(c => c.name === warning);
        const msg = check ? check.message.substring(0, 48) : /* istanbul ignore next */ warning;
        lines.push(`║    ⚠ ${msg.padEnd(50)} ║`);
      }
    }

    lines.push('╚══════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  }

  private logResults(result: BootstrapResult, report: string): void {
    // @audit-ok: startup-only — runs once during bootstrap
    console.log(report);

    if (!result.success) {
       
      console.error('[BootstrapOrchestrator] CRITICAL: Bootstrap failed due to integrity check failures');
       
      console.error('[BootstrapOrchestrator] Failed critical checks:', result.failedCritical.join(', '));
    } else if (result.failedWarnings.length > 0) {
       
      console.warn('[BootstrapOrchestrator] Bootstrap completed with warnings:', result.failedWarnings.join(', '));
    } else {
       
      console.log('[BootstrapOrchestrator] Bootstrap completed successfully');
    }
  }

  getChecker(): SystemIntegrityChecker {
    return this.checker;
  }
}

export async function runBootstrapChecks(
  options?: BootstrapOrchestratorOptions
): Promise<BootstrapOrchestratorResult> {
  const orchestrator = new BootstrapOrchestrator(options);
  return orchestrator.bootstrap();
}
