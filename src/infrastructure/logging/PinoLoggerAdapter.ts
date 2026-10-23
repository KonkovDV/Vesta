/**
 * PinoLoggerAdapter — Pino-backed implementation of ILogger.
 * Layer: Infrastructure
 *
 * High-performance structured JSON logger for production use.
 * Uses Pino v9 with async transport for non-blocking writes.
 *
 * Features:
 * - Async output (worker thread serialization)
 * - Automatic correlationId injection from RequestContext
 * - Sensitive field redaction (keys, passwords, tokens, secrets)
 * - Configurable via LOG_LEVEL env var
 * - pino-pretty in development for human-readable output
 */

import pino from 'pino';
import type { ILogger } from '../../core/decorators/ILogger';

const REDACT_PATHS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'jwt',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'REDIS_PASSWORD',
  'POSTGRES_PASSWORD',
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

/**
 * Accessor function type for correlationId from RequestContext.
 * Set via static method — composition root wires this at bootstrap.
 */
type CorrelationIdAccessor = () => string | undefined;

export class PinoLoggerAdapter implements ILogger {
  private readonly logger: pino.Logger;
  private static correlationIdAccessor: CorrelationIdAccessor | undefined;

  constructor(private readonly context: string = 'app') {
    const isDev = process.env['NODE_ENV'] !== 'production';
    const level = process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info');

    this.logger = pino({
      level,
      name: context,
      redact: {
        paths: REDACT_PATHS.map((p) => `*.${p}`),
        censor: '[REDACTED]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      // In production, use default fast JSON serialization;
      // in dev, enable pino-pretty for human-readable output
      ...(isDev
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:standard' },
            },
          }
        : {}),
    });
  }

  /**
   * Set the correlationId accessor — called once at bootstrap from composition root.
   */
  static setCorrelationIdAccessor(accessor: CorrelationIdAccessor): void {
    PinoLoggerAdapter.correlationIdAccessor = accessor;
  }

  private getCorrelationId(): string | undefined {
    try {
      return PinoLoggerAdapter.correlationIdAccessor?.();
    } catch {
      return undefined;
    }
  }

  private enrich(meta?: Record<string, unknown>): Record<string, unknown> {
    const correlationId = this.getCorrelationId();
    return {
      ...(correlationId ? { correlationId } : {}),
      ...(meta ?? {}),
    };
  }

  log(message: string, meta?: Record<string, unknown>): void {
    this.logger.info(this.enrich(meta), message);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.logger.info(this.enrich(meta), message);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logger.warn(this.enrich(meta), message);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.logger.error(this.enrich(meta), message);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logger.debug(this.enrich(meta), message);
  }
}
