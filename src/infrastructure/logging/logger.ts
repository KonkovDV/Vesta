/**
 * Простая обертка над console.* для унифицированного логирования.
 * Layer: Infrastructure
 *
 * Использование:
 *   import { logger } from './logger.js';
 *   logger.info('message', { meta: 123 });
 */

export type Logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  child: (bindings: Record<string, unknown>) => Logger;
};

function format(prefix: string, msg: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  if (meta && Object.keys(meta).length > 0) {
    return `[${ts}] ${prefix} ${msg} :: ${JSON.stringify(meta)}`;
  }
  return `[${ts}] ${prefix} ${msg}`;
}

function makeLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, meta) => console.debug(format('DEBUG', msg, { ...bindings, ...meta })),
    info: (msg, meta) => console.info(format('INFO', msg, { ...bindings, ...meta })),
    warn: (msg, meta) => console.warn(format('WARN', msg, { ...bindings, ...meta })),
    error: (msg, meta) => console.error(format('ERROR', msg, { ...bindings, ...meta })),
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  };
}

export const logger: Logger = makeLogger();