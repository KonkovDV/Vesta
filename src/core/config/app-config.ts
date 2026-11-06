/**
 * App Config - централизованный конфиг приложения
 * Layer: Core
 *
 * Предоставляет удобные функции чтения окружения и метрик-конфиг
 * поверх типизированного AppConfig из src/config.
 */

import type { AppConfig } from '../../config/schema';
import { getConfig } from '../../config';

// Базовые ридеры окружения поверх AppConfig

function getSnapshot(): AppConfig {
  return getConfig();
}

export function readBool<K extends keyof AppConfig>(name: K, def: boolean): boolean {
  const config = getSnapshot();
  const raw: unknown = config[name];
  // The schema may already have coerced the value (z.coerce / z.boolean()).
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return def;
  }
  const s = raw.toLowerCase();
  return !(s === 'false' || s === '0' || s === 'no' || s === 'off');
}

export function readInt<K extends keyof AppConfig>(name: K, def: number): number {
  const config = getSnapshot();
  const raw: unknown = config[name];
  // REDIS_PORT and REDIS_DB are z.coerce.number() in the schema: a number arrives here.
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.trunc(raw) : def;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return def;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

export function readStr<K extends keyof AppConfig>(
  name: K,
  def?: string,
): string | undefined {
  const config = getSnapshot();
  const raw: unknown = config[name];
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw);
  }
  if (typeof raw !== 'string' || raw === '') {
    return def;
  }
  return raw;
}

export function readFloatList<K extends keyof AppConfig>(
  name: K,
  def: number[],
): number[] {
  const config = getSnapshot();
  const raw = config[name];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return def;
  }
  const arr = raw
    .split(/[,\s]+/)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n));
  return arr.length ? arr : def;
}

export function readBoolMulti<K extends keyof AppConfig>(
  names: K[],
  def: boolean,
): boolean {
  const config = getSnapshot();
  for (const name of names) {
    const raw = config[name];
    if (typeof raw === 'string') {
      const s = raw.toLowerCase();
      return !(s === 'false' || s === '0' || s === 'no' || s === 'off');
    }
  }
  return def;
}

// Метрики
export interface MetricsConfig {
  enabled: boolean;
  appRouteEnabled: boolean;
  defaultBucketsSeconds: number[];
  httpBucketsSeconds: number[];
  eventLatencyBucketsMs: number[];
}

export function getMetricsConfig(): MetricsConfig {
  const enabled = readBoolMulti(['METRICS_ENABLED', 'APP_ENABLE_METRICS'], true);
  const appRouteEnabled = readBool(
    'APP_METRICS_ROUTE_ENABLED',
    getSnapshot().NODE_ENV !== 'production',
  );

  const httpBucketsSeconds = readFloatList(
    'METRICS_HTTP_BUCKETS',
    [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  );

  const defaultBucketsSeconds = readFloatList(
    'METRICS_DEFAULT_BUCKETS',
    httpBucketsSeconds,
  );

  const eventLatencyBucketsMs = readFloatList(
    'METRICS_EVENT_LATENCY_MS_BUCKETS',
    [5, 10, 25, 50, 100, 250, 500, 1000, 2000],
  );

  return {
    enabled,
    appRouteEnabled,
    defaultBucketsSeconds,
    httpBucketsSeconds,
    eventLatencyBucketsMs,
  };
}

/**
 * Hybrid retrieval (BM25 + vector) stays opt-in for production.
 *
 * The current BM25 implementation is intentionally @sota-stub and in-memory,
 * so production defaults to vector-only archival retrieval unless explicitly
 * enabled. Non-production environments preserve the previous default.
 */
export function isHybridRetrievalEnabled(): boolean {
  // istanbul ignore next -- readStr with string default never returns undefined
  const nodeEnv = readStr('NODE_ENV', 'development') ?? 'development';
  const defaultEnabled = nodeEnv !== 'production';
  return readBool('HYBRID_RETRIEVAL_ENABLED', defaultEnabled);
}