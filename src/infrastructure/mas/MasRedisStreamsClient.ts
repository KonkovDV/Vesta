import Redis, { Redis as RedisClient } from 'ioredis';
import type { RedisConnectionConfig } from '../config/config';
import { getRedisEventBusConfig } from '../config/config';
import { getConfig } from '../../config';

export interface MasRedisStreamsClientConfig {
  connection: RedisConnectionConfig;
  streamKey: string;
  maxLen?: number;
  dedupTtlSeconds?: number;
}

export interface MasStreamEntry {
  id: string;
  fields: Record<string, string>;
}

export class MasRedisStreamsClient {
  private readonly redis: RedisClient;
  private readonly streamKey: string;
  private readonly maxLen?: number;
  private readonly dedupTtlSeconds?: number;
  private closed = false;

  constructor(config: MasRedisStreamsClientConfig) {
    this.streamKey = config.streamKey;
    this.maxLen = config.maxLen;
    this.dedupTtlSeconds = config.dedupTtlSeconds;

    const {
      host,
      port,
      password,
      db,
      retryDelayOnFailover,
      enableOfflineQueue,
      lazyConnect,
      maxRetriesPerRequest,
      tls,
    } = config.connection;

    this.redis = new Redis({
      host: host ?? 'localhost',
      port: port ?? 6379,
      password,
      db: db ?? 0,
      retryStrategy: (times) => {
        const base = retryDelayOnFailover ?? 100;
        return Math.min(base * Math.max(1, times), 2000);
      },
      enableOfflineQueue: enableOfflineQueue ?? true,
      lazyConnect: lazyConnect ?? true,
      maxRetriesPerRequest: maxRetriesPerRequest ?? 3,
      tls,
    });

    this.redis.on('error', (err) => {
       
      console.error('[MasRedisStreamsClient] Redis error:', err);
    });
  }

  async append(fields: Record<string, string>, dedupKey?: string): Promise<string | null> {
    if (this.closed) {
      throw new Error('MasRedisStreamsClient is closed');
    }

    if (dedupKey && this.dedupTtlSeconds && this.dedupTtlSeconds > 0) {
      const key = `${this.streamKey}:dedup:${dedupKey}`;
      const res = await this.redis.set(key, '1', 'EX', this.dedupTtlSeconds, 'NX');
      if (res === null) {
        return null;
      }
    }

    const args: Array<string | number> = [];
    if (this.maxLen && this.maxLen > 0) {
      args.push('MAXLEN', '~', this.maxLen);
    }

    const fieldArgs: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      fieldArgs.push(k, v);
    }

    const id = await (this.redis as unknown as { xadd: (...argv: Array<string | number>) => Promise<string> }).xadd(
      this.streamKey,
      ...args,
      '*',
      ...fieldArgs,
    );

    return id;
  }

  async ensureConsumerGroup(groupName: string): Promise<void> {
    if (this.closed) {
      throw new Error('MasRedisStreamsClient is closed');
    }

    try {
      await (this.redis as unknown as { xgroup: (...argv: Array<string | number>) => Promise<unknown> }).xgroup(
        'CREATE',
        this.streamKey,
        groupName,
        '0',
        'MKSTREAM',
      );
    } catch (err) {
      const message = (err as Error).message || '';
      if (!message.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  async readGroup(
    groupName: string,
    consumerName: string,
    count: number,
    blockMs: number,
  ): Promise<MasStreamEntry[]> {
    if (this.closed) {
      throw new Error('MasRedisStreamsClient is closed');
    }

    const args: Array<string | number> = [
      'GROUP',
      groupName,
      consumerName,
      'COUNT',
      count,
      'BLOCK',
      blockMs,
      'STREAMS',
      this.streamKey,
      '>',
    ];

    const raw = await (this.redis as unknown as {
      xreadgroup: (...argv: Array<string | number>) => Promise<unknown>;
    }).xreadgroup(...args);

    if (!raw) {
      return [];
    }

    const entries: MasStreamEntry[] = [];
    const streams = raw as [string, [string, string[]][]][];

    for (const [, records] of streams) {
      for (const [id, fieldList] of records) {
        const fields: Record<string, string> = {};
        for (let i = 0; i < fieldList.length; i += 2) {
          const key = fieldList[i];
          const value = fieldList[i + 1];
          fields[key] = value;
        }
        entries.push({ id, fields });
      }
    }

    return entries;
  }

  async ack(groupName: string, ids: string[]): Promise<number> {
    if (this.closed) {
      throw new Error('MasRedisStreamsClient is closed');
    }
    if (ids.length === 0) {
      return 0;
    }

    const res = await (this.redis as unknown as {
      xack: (key: string, group: string, ...idArgs: string[]) => Promise<number>;
    }).xack(
      this.streamKey,
      groupName,
      ...ids,
    );
    return res;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.redis.quit();
  }

  /**
   * Exposes the underlying Redis client for advanced operations.
   * Use with caution; prefer higher-level methods when available.
   */
  getRedis(): RedisClient {
    return this.redis;
  }
}

export function createMasRedisStreamsClientFromEnv(): MasRedisStreamsClient {
  const base = getRedisEventBusConfig();
  const cfg = getConfig();

  const maxLenRaw = cfg.MAS_REDIS_STREAMS_MAXLEN;
  const dedupRaw = cfg.MAS_REDIS_STREAMS_DEDUP_TTL_SECONDS;

  const maxLen = typeof maxLenRaw === 'string' && maxLenRaw.trim().length > 0
    ? Number.parseInt(maxLenRaw, 10)
    : NaN;
  const dedupTtl = typeof dedupRaw === 'string' && dedupRaw.trim().length > 0
    ? Number.parseInt(dedupRaw, 10)
    : NaN;

  const streamKey = 'mas:events';

  return new MasRedisStreamsClient({
    connection: base.connection,
    streamKey,
    maxLen: Number.isFinite(maxLen) && maxLen > 0 ? maxLen : undefined,
    dedupTtlSeconds: Number.isFinite(dedupTtl) && dedupTtl > 0 ? dedupTtl : undefined,
  });
}
