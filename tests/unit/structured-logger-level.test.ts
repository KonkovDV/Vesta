/**
 * MP-K25: StructuredLogger wrote every record whatever LOG_LEVEL said, so a 401
 * still produced the aspect's debug line. The threshold now follows LOG_LEVEL,
 * with the same default as the Pino adapter: debug outside production, info in it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuredLogger } from '../../src/infrastructure/logging/StructuredLogger';

function capture(work: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    work();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return { out, err };
}

function withEnv(values: Record<string, string | undefined>, work: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function levelsWritten(): string[] {
  const logger = new StructuredLogger('level-probe');
  const { out, err } = capture(() => {
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
  });
  return [...out, ...err].map((line) => (JSON.parse(line) as { level: string }).level);
}

test('LOG_LEVEL=info drops debug records and keeps the rest', () => {
  withEnv({ LOG_LEVEL: 'info' }, () => {
    assert.deepEqual(levelsWritten(), ['info', 'warn', 'error']);
  });
});

test('LOG_LEVEL=warn drops info and debug; error is always written', () => {
  withEnv({ LOG_LEVEL: 'WARN' }, () => {
    assert.deepEqual(levelsWritten(), ['warn', 'error']);
  });
  withEnv({ LOG_LEVEL: 'error' }, () => {
    assert.deepEqual(levelsWritten(), ['error']);
  });
});

test('without LOG_LEVEL the default matches the Pino adapter', () => {
  withEnv({ LOG_LEVEL: undefined, NODE_ENV: 'production' }, () => {
    assert.deepEqual(levelsWritten(), ['info', 'warn', 'error']);
  });
  withEnv({ LOG_LEVEL: undefined, NODE_ENV: 'development' }, () => {
    assert.deepEqual(levelsWritten(), ['debug', 'info', 'warn', 'error']);
  });
  withEnv({ LOG_LEVEL: 'verbose', NODE_ENV: 'production' }, () => {
    assert.deepEqual(levelsWritten(), ['info', 'warn', 'error'], 'an unknown value falls back to the default');
  });
});

test('an error-like object without a stack is logged without one', () => {
  withEnv({ LOG_LEVEL: 'info' }, () => {
    const logger = new StructuredLogger('level-probe');
    const { out } = capture(() => {
      // LoggingAspect drops the stack of a 4xx; the logger must not invent its own.
      logger.warn('[AOP][AuthService.authenticateRequest] failed', { error: { name: 'Error', message: 'API token is required' } });
      logger.warn('with stack', { error: { name: 'Error', message: 'boom', stack: 'Error: boom\n    at origin' } });
    });
    const [withoutStack, withStack] = out.map((line) => JSON.parse(line) as { error?: { message: string; stack?: string } });
    assert.equal(withoutStack.error?.message, 'API token is required');
    assert.equal(withoutStack.error?.stack, undefined);
    assert.equal(withStack.error?.stack, 'Error: boom\n    at origin');
  });
});
