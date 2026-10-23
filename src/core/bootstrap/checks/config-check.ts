/**
 * Configuration Validation Check
 * Validates application configuration structure and values
 */

import { BaseIntegrityCheck, CheckResult } from '../system-integrity-checker';
import { getConfig } from '../../../config';

export class ConfigCheck extends BaseIntegrityCheck {
  readonly name = 'config';
  readonly description = 'Validates application configuration';
  readonly priority = 2; // Very high priority, right after environment
  readonly severity = 'critical';
  readonly timeoutMs = 3000;

  async check(): Promise<CheckResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const info: Record<string, unknown> = {};

    try {
      const config = getConfig();

      // Validate required config sections
      if (!config) {
        return this.fail('Configuration is empty or undefined');
      }

      // Check PORT
      if (config.PORT !== undefined) {
        if (typeof config.PORT !== 'number' || config.PORT < 1 || config.PORT > 65535) {
          errors.push(`Invalid PORT: ${config.PORT} (must be 1-65535)`);
        } else {
          info.port = config.PORT;
        }
      }

      // Check LOG_LEVEL
      const validLogLevels = ['debug', 'info', 'warn', 'error'];
      if (config.LOG_LEVEL && typeof config.LOG_LEVEL === 'string' &&
          !validLogLevels.includes(config.LOG_LEVEL.toLowerCase())) {
        warnings.push(`Unusual LOG_LEVEL: ${config.LOG_LEVEL}`);
      }

      // Check timeouts are reasonable
      if (config.INFRA_INIT_TIMEOUT_MS) {
        const timeout = typeof config.INFRA_INIT_TIMEOUT_MS === 'string'
          ? parseInt(config.INFRA_INIT_TIMEOUT_MS, 10)
          : config.INFRA_INIT_TIMEOUT_MS;
        if (timeout < 1000) {
          warnings.push(`INFRA_INIT_TIMEOUT_MS is very short (${timeout}ms)`);
        } else if (timeout > 120000) {
          warnings.push(`INFRA_INIT_TIMEOUT_MS is very long (${timeout}ms)`);
        }
      }

      // Check feature flags consistency
      const nodeEnv = config.env;
      if (nodeEnv === 'production') {
        if (config.DEBUG === true || config.DEBUG === 'true') {
          warnings.push('DEBUG mode enabled in production');
        }
      }

      // Validate database configuration
      if (config.DATABASE_URL) {
        try {
          const dbUrl = new URL(config.DATABASE_URL);
          if (!dbUrl.protocol || !dbUrl.hostname) {
            errors.push('DATABASE_URL has invalid format');
          } else {
            info.databaseType = dbUrl.protocol.replace(':', '');
            info.databaseHost = dbUrl.hostname;
          }
        } catch {
          errors.push('DATABASE_URL is not a valid URL');
        }
      }

      // Summary
      const details: Record<string, unknown> = {
        configLoaded: true,
        info,
        warnings: warnings.length > 0 ? warnings : undefined,
      };

      if (errors.length > 0) {
        return this.fail(`Configuration validation failed: ${errors.join('; ')}`, {
          ...details,
          errors,
        });
      }

      if (warnings.length > 0) {
        return {
          passed: true,
          message: `Configuration valid with ${warnings.length} warnings`,
          details,
        };
      }

      return this.pass('Configuration validated successfully', details);
    } catch (error) {
      return this.fail(`Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`, {
        error: String(error),
      });
    }
  }
}
