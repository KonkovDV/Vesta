/**
 * Database Connectivity Check
 * Validates database connection and basic operations
 */

import { BaseIntegrityCheck, CheckResult } from '../system-integrity-checker';
import { container } from '../../di/container';
import { getRawEnv } from '../../../config';

interface DatabaseConnection {
  query?(sql: string): Promise<unknown>;
  ping?(): Promise<void>;
  isConnected?(): boolean;
}

export class DatabaseCheck extends BaseIntegrityCheck {
  readonly name = 'database';
  readonly description = 'Validates database connectivity';
  readonly priority = 10;
  readonly severity = 'critical';
  readonly timeoutMs = 5000;

  async check(): Promise<CheckResult> {
    const errors: string[] = [];
    let connectionStatus = 'unknown';
    let latencyMs: number | undefined;

    try {
      // Check if database is registered in DI container
      // Check if database is registered in DI container
      if (!container.isRegistered('DatabaseConnection')) {
        // If no DB configured, check if DATABASE_URL is set
        if (!getRawEnv().DATABASE_URL) {
          return this.pass('No database configured (DATABASE_URL not set)', {
            status: 'skipped',
            reason: 'DATABASE_URL not configured',
          });
        }
        // In Phase 0 (Pre-Bootstrap), DI is not ready yet. 
        // We validate that config is present, but skip connectivity check.
        return this.pass('Database config present (connectivity check deferred until DI bootstrap)', {
            status: 'deferred',
            reason: 'DI container not yet populated',
        });
      }

      const db = container.resolve<DatabaseConnection>('DatabaseConnection');

      // Test connectivity with timing
      const startTime = Date.now();

      if (typeof db.ping === 'function') {
        await db.ping();
        latencyMs = Date.now() - startTime;
        connectionStatus = 'connected';
      } else if (typeof db.isConnected === 'function') {
        if (db.isConnected()) {
          latencyMs = Date.now() - startTime;
          connectionStatus = 'connected';
        } else {
          connectionStatus = 'disconnected';
          errors.push('Database reports disconnected state');
        }
      } else if (typeof db.query === 'function') {
        await db.query('SELECT 1');
        latencyMs = Date.now() - startTime;
        connectionStatus = 'connected';
      } else {
        errors.push('Database connection has no recognized test method (ping, isConnected, or query)');
      }
    } catch (error) {
      connectionStatus = 'error';
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`Database connection error: ${errorMessage}`);
    }

    if (errors.length > 0) {
      return this.fail(`Database connectivity check failed: ${errors.join(', ')}`, {
        status: connectionStatus,
        errors,
      });
    }

    return this.pass('Database connectivity verified', {
      status: connectionStatus,
      latencyMs,
    });
  }
}
