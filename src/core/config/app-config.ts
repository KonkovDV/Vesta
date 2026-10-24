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
 * R2.2 Event Store partitioning POC (C1/C2):
 * feature-flag accessor used by infra/DI to toggle partitioning behaviour.
 *
 * When disabled (default), runtime behaviour of Event Store must remain
 * byte-for-byte compatible with the current monolithic `events` table.
 */
export function getEventStorePartitioningPocEnabled(): boolean {
  return readBool('EVENT_STORE_PARTITIONING_POC_ENABLED', false);
}

/**
 * R2.4 Event Store cutover (C1):
 * normalized accessor for EVENT_STORE_CUTOVER_MODE.
 *
 * Modes:
 * - canonical_only (default)  – State A, canonical monolithic table only;
 * - shadow_read               – State B, canonical read + shadow read from events_v2;
 * - dual_read                 – future dual-read/compare routing;
 * - cutover_to_v2             – future full cutover to events_v2.
 *
 * For C1 this accessor is configuration-only and must not alter Event Store behaviour.
 * Unknown/empty values fallback to canonical_only.
 */
export type EventStoreCutoverMode =
  | 'canonical_only'
  | 'shadow_read'
  | 'dual_read'
  | 'cutover_to_v2';
 
const DEFAULT_EVENT_STORE_CUTOVER_MODE: EventStoreCutoverMode = 'canonical_only';
 
export function getEventStoreCutoverMode(): EventStoreCutoverMode {
  const raw = readStr('EVENT_STORE_CUTOVER_MODE');
  if (!raw) {
    return DEFAULT_EVENT_STORE_CUTOVER_MODE;
  }
 
  const normalized = raw.trim().toLowerCase().replace(/-/g, '_');
 
  switch (normalized) {
    case 'canonical_only':
      return 'canonical_only';
    case 'shadow_read':
      return 'shadow_read';
    case 'dual_read':
      return 'dual_read';
    case 'cutover_to_v2':
      return 'cutover_to_v2';
    default:
      return DEFAULT_EVENT_STORE_CUTOVER_MODE;
  }
}
 
/**
 * R2.4-D2 Event Store write-primary mode:
 * normalized accessor for EVENT_STORE_WRITE_PRIMARY_MODE.
 *
 * Modes:
 * - events          (default)       – State D, write-primary = canonical monolithic `events`;
 * - events_v2_dual  (D2a staging)   – write-primary = partitioned `events_v2`, mandatory dual-write to `events`;
 * - events_v2_only  (D2b final)     – write-primary = `events_v2` only, `events` used as read-only archive.
 *
 * Unknown/empty values fallback to events.
 */
export type EventStoreWritePrimaryMode = 'events' | 'events_v2_dual' | 'events_v2_only';
 
const DEFAULT_EVENT_STORE_WRITE_PRIMARY_MODE: EventStoreWritePrimaryMode = 'events';
 
export function getEventStoreWritePrimaryMode(): EventStoreWritePrimaryMode {
  const raw = readStr('EVENT_STORE_WRITE_PRIMARY_MODE');
  if (!raw) {
    return DEFAULT_EVENT_STORE_WRITE_PRIMARY_MODE;
  }
 
  const normalized = raw.trim().toLowerCase().replace(/-/g, '_');
 
  switch (normalized) {
    case 'events':
      return 'events';
    case 'events_v2_dual':
      return 'events_v2_dual';
    case 'events_v2_only':
      return 'events_v2_only';
    default:
      return DEFAULT_EVENT_STORE_WRITE_PRIMARY_MODE;
  }
}
 
/**
 * R2.3 MAS Redis Streams pilot:
 * feature-flag accessors used by infra/DI to toggle Redis Streams producer and projectors.
 *
 * When disabled (default), MAS Redis Streams producer/projectors must remain inactive and
 * the canonical Event Store read-path must stay unchanged.
 */
export function isMasRedisStreamsPilotEnabled(): boolean {
  return readBool('MAS_REDIS_STREAMS_PILOT_ENABLED', false);
}

export function isMasRedisStreamsProducerEnabled(): boolean {
  return readBoolMulti(
    ['MAS_REDIS_STREAMS_PRODUCER_ENABLED', 'MAS_REDIS_STREAMS_PILOT_ENABLED'],
    false,
  );
}

export function isMasRedisStreamsProjectorsEnabled(): boolean {
  return readBoolMulti(
    ['MAS_REDIS_STREAMS_PROJECTORS_ENABLED', 'MAS_REDIS_STREAMS_PILOT_ENABLED'],
    false,
  );
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