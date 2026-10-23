/**
 * Security Baseline Check
 * Validates basic security configurations
 */

import { BaseIntegrityCheck, CheckResult } from '../system-integrity-checker';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getRawEnv } from '../../../config';

export class SecurityCheck extends BaseIntegrityCheck {
  readonly name = 'security';
  readonly description = 'Validates security baseline configurations';
  readonly priority = 20;
  readonly severity = 'warning';
  readonly timeoutMs = 3000;
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    super();
    this.rootDir = rootDir ?? process.cwd();
  }

  async check(): Promise<CheckResult> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const info: string[] = [];

    // Check NODE_ENV security
    const nodeEnv = getRawEnv().NODE_ENV;
    if (!nodeEnv) {
      errors.push('NODE_ENV not set');
    } else if (nodeEnv === 'development') {
      warnings.push('Running in development mode');
    }

    // Check for secure secrets/tokens
    const secretVars = [
      'JWT_SECRET',
      'SESSION_SECRET',
      'API_KEY',
      'PRIVATE_KEY',
    ];

    for (const secretVar of secretVars) {
      const value = getRawEnv()[secretVar];
      if (value) {
        if (value.length < 16) {
          warnings.push(`${secretVar} is too short (should be at least 16 characters)`);
        }
        if (value === 'secret' || value === 'password' || value === '123456') {
          errors.push(`${secretVar} uses a default/weak value`);
        }
        if (value === 'changeme' || value === 'default') {
          warnings.push(`${secretVar} appears to be a placeholder value`);
        }
      }
    }

    // Check for HTTPS in production
    if (nodeEnv === 'production') {
      if (getRawEnv().DISABLE_HTTPS === 'true') {
        warnings.push('HTTPS is disabled in production');
      }
      if (!getRawEnv().SSL_CERT_PATH && !getRawEnv().TRUST_PROXY) {
        info.push('No SSL certificate or trust proxy configured (may be handled by load balancer)');
      }
    }

    // Check for .env file in production (should use proper secret management)
    if (nodeEnv === 'production') {
      try {
        const envPath = path.join(this.rootDir, '.env');
        await fs.access(envPath);
        warnings.push('.env file exists in production (consider using secret management service)');
      } catch {
        // No .env file, good
      }
    }

    // Check for security headers configuration
    if (!getRawEnv().SECURITY_HEADERS_DISABLED) {
      info.push('Security headers enabled by default');
    } else {
      warnings.push('Security headers are disabled');
    }

    // Check for CORS configuration
    if (getRawEnv().CORS_ORIGIN === '*') {
      warnings.push('CORS is configured to allow all origins (*)');
    }

    // Check for rate limiting
    if (!getRawEnv().RATE_LIMIT_ENABLED && nodeEnv === 'production') {
      warnings.push('Rate limiting not explicitly enabled in production');
    }

    // Summary
    const details: Record<string, unknown> = {
      nodeEnv,
      warnings: warnings.length > 0 ? warnings : undefined,
      info: info.length > 0 ? info : undefined,
      secretsConfigured: secretVars.filter(v => getRawEnv()[v]).length,
    };

    if (errors.length > 0) {
      return this.fail(`Security baseline check failed: ${errors.join('; ')}`, {
        ...details,
        errors,
      });
    }

    if (warnings.length > 0) {
      return {
        passed: true,
        message: `Security baseline verified with ${warnings.length} warnings`,
        details,
      };
    }

    return this.pass('Security baseline verified', details);
  }
}
