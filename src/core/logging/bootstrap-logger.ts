/**
 * Bootstrap Logger — Pre-DI Logger for module registration code.
 *
 * Layer: Core (Zero-dependency)
 *
 * Problem: DI modules and bootstrap code run BEFORE the ILogger is registered.
 * They cannot resolve ILogger from the container. This utility provides a
 * structured logger that:
 *  1. Works before DI is available (falls back to console)
 *  2. Includes a `[module]` tag for traceability
 *  3. Can be upgraded to the real ILogger once DI is ready
 *  4. Automatically includes correlationId from ambient RequestContext (when available)
 *
 * Usage:
 *   import { getBootstrapLogger } from '../../core/logging/bootstrap-logger';
 *   const log = getBootstrapLogger('core-infra');
 *   log.info('Database services registered');
 */

import type { ILogger } from '../decorators/ILogger';

/**
 * Minimal bootstrap logger that wraps console with structured output.
 * Compatible with ILogger interface.
 */
class BootstrapLoggerImpl implements ILogger {
  constructor(private readonly module: string) {}

  private prefix(): string {
    return `[bootstrap:${this.module}]`;
  }

  private tryGetCorrelationId(): string | undefined {
    try {
      // Lazy import to avoid circular deps — RequestContext may not exist yet
      const { RequestContext } = require('../../application/context/request-context');
      if (RequestContext.isInContext()) {
        return RequestContext.getContext().correlationId;
      }
    } catch {
      // RequestContext not available (early bootstrap), skip
    }
    return undefined;
  }

  private meta(extra?: Record<string, unknown> | unknown): Record<string, unknown> {
    const correlationId = this.tryGetCorrelationId();
    const extraObj = (extra && typeof extra === 'object' && !Array.isArray(extra))
      ? extra as Record<string, unknown>
      : extra !== undefined ? { value: extra } : {};
    return {
      ...(correlationId ? { correlationId } : {}),
      ...(extraObj),
    };
  }

  log(message: string, m?: Record<string, unknown> | unknown): void {
    const merged = this.meta(m);
    if (Object.keys(merged).length > 0) {
      console.log(this.prefix(), message, merged);
    } else {
      console.log(this.prefix(), message);
    }
  }

  info(message: string, m?: Record<string, unknown> | unknown): void {
    const merged = this.meta(m);
    if (Object.keys(merged).length > 0) {
      console.info(this.prefix(), message, merged);
    } else {
      console.info(this.prefix(), message);
    }
  }

  warn(message: string, m?: Record<string, unknown> | unknown): void {
    const merged = this.meta(m);
    if (Object.keys(merged).length > 0) {
      console.warn(this.prefix(), message, merged);
    } else {
      console.warn(this.prefix(), message);
    }
  }

  error(message: string, m?: Record<string, unknown> | unknown): void {
    const merged = this.meta(m);
    if (Object.keys(merged).length > 0) {
      console.error(this.prefix(), message, merged);
    } else {
      console.error(this.prefix(), message);
    }
  }

  debug(message: string, m?: Record<string, unknown> | unknown): void {
    if (process.env.NODE_ENV === 'production') return; // suppress debug in prod
    const merged = this.meta(m);
    if (Object.keys(merged).length > 0) {
      console.debug(this.prefix(), message, merged);
    } else {
      console.debug(this.prefix(), message);
    }
  }
}

/** Cache of loggers to avoid re-creation (OOM-003: bounded to 200 entries) */
const loggerCache = new Map<string, BootstrapLoggerImpl>();
const LOGGER_CACHE_MAX = 200;

/**
 * Get a bootstrap-safe logger for a given module name.
 * Safe to call before DI is initialized.
 */
export function getBootstrapLogger(moduleName: string): ILogger {
  let logger = loggerCache.get(moduleName);
  if (!logger) {
    logger = new BootstrapLoggerImpl(moduleName);
    loggerCache.set(moduleName, logger);
    if (loggerCache.size > LOGGER_CACHE_MAX) {
      const oldest = loggerCache.keys().next().value;
      /* istanbul ignore next -- defensive: Map with size>200 always has keys */
      if (oldest) loggerCache.delete(oldest);
    }
  }
  return logger;
}

/** @internal Test-only helper to reset logger cache between tests (TEST-045) */
export function _test_clearBootstrapLoggerCache(): void {
  loggerCache.clear();
}
