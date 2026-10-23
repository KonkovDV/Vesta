/**
 * Environment Variables Check
 * Validates required environment variables are set and have valid values
 */

import { BaseIntegrityCheck, CheckResult } from '../system-integrity-checker';
import { getConfig, getRawEnv } from '../../../config';

export class EnvironmentCheck extends BaseIntegrityCheck {
  readonly name = 'EnvironmentCheck';
  readonly description = 'Validates required environment variables';
  readonly priority = 10; // High priority
  readonly severity = 'critical' as const;

  private readonly requiredVars = ['NODE_ENV', 'PORT'];

  async check(): Promise<CheckResult> {
    const missing: string[] = [];
    const invalid: string[] = [];
    const warnings: string[] = [];
    const env = getRawEnv();

    // Check required variables
    for (const varName of this.requiredVars) {
      if (!env[varName]) {
        missing.push(varName);
      }
    }

    // Validate NODE_ENV values
    const nodeEnv = env.NODE_ENV;
    if (nodeEnv && !['development', 'production', 'test'].includes(nodeEnv)) {
      invalid.push(`NODE_ENV must be development, production, or test (got: ${nodeEnv})`);
    }

    // Check for production-specific variables
    if (nodeEnv === 'production') {
      const prodVars = ['DATABASE_URL'];
      for (const varName of prodVars) {
        if (!env[varName]) {
          warnings.push(`Production variable ${varName} is not set`);
        }
      }

      // Security warnings for production
      if (env.DEBUG === 'true') {
        warnings.push('DEBUG=true in production environment');
      }
    }

    // Try to load config to verify Zod validation passes
    try {
      const config = getConfig();
      if (config.PORT !== undefined && (typeof config.PORT !== 'number' || config.PORT < 1 || config.PORT > 65535)) {
        invalid.push(`PORT must be a valid port number (1-65535)`);
      }
    } catch (error) {
      return this.fail(`Config validation failed: ${error instanceof Error ? error.message : String(error)}`, {
        error: String(error),
      });
    }

    if (missing.length > 0 || invalid.length > 0) {
      return this.fail('Environment validation failed', {
        missing,
        invalid,
        warnings,
      });
    }

    const details: Record<string, unknown> = {
      checkedVars: this.requiredVars.length,
      nodeEnv,
      warnings: warnings.length > 0 ? warnings : undefined,
    };

    if (warnings.length > 0) {
      return {
        passed: true,
        message: `Environment variables valid (${warnings.length} warnings)`,
        details,
      };
    }

    return this.pass('All environment variables are valid', details);
  }
}
