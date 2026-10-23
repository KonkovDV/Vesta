/**
 * RedisAdapter - адаптер для Redis
 * Layer: Infrastructure
 *
 * Реализует ICache интерфейс для работы с Redis.
 * Инкапсулирует специфику Redis и предоставляет унифицированный интерфейс.
 *
 * @example
 * ```typescript
 * import { readStr, readInt } from '../../core/config/app-config';
 *
 * const host = readStr('REDIS_HOST', 'localhost');
 * const port = readInt('REDIS_PORT', 6379);
 * const password = readStr('REDIS_PASSWORD');
 *
 * const adapter = new RedisAdapter({
 *   host,
 *   port,
 *   password,
 * });
 *
 * await adapter.set('user:123', userData, { ttlSeconds: 300 });
 * const user = await adapter.get<User>('user:123');
 * ```
 */

import Redis, { Redis as RedisClient, Cluster } from 'ioredis';
import { ICache, CacheSetOptions, CacheGetResult, CacheKeyInfo, CacheStats, CacheScanOptions, CacheScanResult } from '../../domain/cache/ICache';
import { Timestamp, now } from '../../core/types';
import { readBool, readInt, readStr } from '../../core/config/app-config';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';
import { tryJsonParse } from '../../core/utils/json';

/**
 * Конфигурация Redis адаптера
 */
export interface RedisAdapterConfig {
  /** Хост Redis */
  host?: string;
  /** Порт Redis */
  port?: number;
  /** Пароль Redis */
  password?: string;
  /** Номер базы данных */
  db?: number;
  /** Ключ-префикс для всех операций */
  keyPrefix?: string;
  /** Включить кластерный режим */
  cluster?: boolean;
  /** Узлы кластера (для кластерного режима) */
  clusterNodes?: Array<{ host: string; port: number }>;
  /** Таймаут подключения в миллисекундах */
  connectTimeout?: number;
  /** Максимальное количество повторных попыток */
  maxRetriesPerRequest?: number;
  /** Включить метрики */
  enableMetrics?: boolean;
}

/**
 * RedisAdapter - реализация ICache для Redis
 */
export class RedisAdapter implements ICache {
  private client: RedisClient | Cluster;
  private config: RedisAdapterConfig;
  private keyPrefix: string;
  private isCluster: boolean;

  // Symmetric listener cleanup — prevents EventEmitter leaks (OOM-008)
  private readonly onConnect: () => void;
  private readonly onError: (err: Error) => void;
  private readonly onReady: () => void;

  // Метрики
  private hits = 0;
  private misses = 0;
  private totalOperations = 0;
  private readonly logger?: IStructuredLogger;

  constructor(config: RedisAdapterConfig = {}, logger?: IStructuredLogger) {
    this.config = {
      host: 'localhost',
      port: 6379,
      db: 0,
      keyPrefix: '',
      cluster: false,
      connectTimeout: 5000,
      maxRetriesPerRequest: 3,
      enableMetrics: true,
      ...config,
    };

    this.keyPrefix = this.config.keyPrefix || '';
    this.isCluster = this.config.cluster || false;
    this.logger = logger;

    if (this.isCluster && this.config.clusterNodes) {
      // Кластерный режим
      this.client = new Redis.Cluster(this.config.clusterNodes, {
        redisOptions: {
          password: this.config.password,
          connectTimeout: this.config.connectTimeout,
          maxRetriesPerRequest: this.config.maxRetriesPerRequest,
        },
      });
    } else {
      // Одиночный режим
      this.client = new Redis({
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        db: this.config.db,
        keyPrefix: this.keyPrefix,
        connectTimeout: this.config.connectTimeout,
        maxRetriesPerRequest: this.config.maxRetriesPerRequest,
      });
    }

    // Bind handlers for symmetric cleanup (OOM-008)
    this.onConnect = () => { console.log('[Redis] Connected'); };
    this.onError = (err: Error) => { console.error('[Redis] Error:', err); };
    this.onReady = () => { console.log('[Redis] Ready'); };

    this.client.on('connect', this.onConnect);
    this.client.on('error', this.onError);
    this.client.on('ready', this.onReady);
  }

  /**
   * Добавить префикс к ключу
   */
  private addPrefix(key: string): string {
    return this.keyPrefix ? `${this.keyPrefix}:${key}` : key;
  }

  /**
   * Убрать префикс из ключа
   */
  private removePrefix(prefixedKey: string): string {
    if (!this.keyPrefix) return prefixedKey;
    return prefixedKey.startsWith(`${this.keyPrefix}:`)
      ? prefixedKey.substring(this.keyPrefix.length + 1)
      : prefixedKey;
  }

  /**
   * Получить значение из кэша
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const prefixedKey = this.addPrefix(key);
      const value = await this.client.get(prefixedKey);

      this.totalOperations++;

      if (value === null) {
        this.misses++;
        return null;
      }

      this.hits++;

      const parsed = tryJsonParse<T>(value);
      if (parsed.ok) {
        return parsed.value;
      }

      return value as T;
    } catch (error) {
      console.error(`[Redis] GET error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Получить значение с дополнительной информацией
   */
  async getWithInfo<T>(key: string): Promise<CacheGetResult<T> | null> {
    try {
      const prefixedKey = this.addPrefix(key);
      const pipeline = this.client.pipeline();

      pipeline.get(prefixedKey);
      pipeline.ttl(prefixedKey);

      const results = await pipeline.exec();
      if (!results) return null;

      const [getResult, ttlResult] = results;

      if (getResult[1] === null) {
        this.misses++;
        this.totalOperations++;
        return null;
      }

      this.hits++;
      this.totalOperations++;

      let value: T;
      {
        const parsed = tryJsonParse<T>(getResult[1] as string);
        if (parsed.ok) {
          value = parsed.value;
        } else {
          value = getResult[1] as T;
        }
      }

      const ttlSeconds = typeof ttlResult[1] === 'number' ? (ttlResult[1]) : undefined;

      return {
        value,
        cachedAt: now(), // Приближенное время
        ttlRemainingSeconds: ttlSeconds && ttlSeconds > 0 ? ttlSeconds : undefined,
      };

    } catch (error) {
      console.error(`[Redis] GET with info error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Установить значение в кэш
   */
  async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    try {
      const prefixedKey = this.addPrefix(key);
      const serializedValue = JSON.stringify(value);

      this.totalOperations++;

      if (options?.onlyIfNotExists) {
        const result = await this.client.set(prefixedKey, serializedValue, 'EX', options.ttlSeconds || 0, 'NX');
        if (!result) {
          throw new Error('Key already exists');
        }
      } else if (options?.onlyIfExists) {
        const result = await this.client.set(prefixedKey, serializedValue, 'EX', options.ttlSeconds || 0, 'XX');
        if (!result) {
          throw new Error('Key does not exist');
        }
      } else if (options?.ttlSeconds) {
        await this.client.setex(prefixedKey, options.ttlSeconds, serializedValue);
      } else {
        await this.client.set(prefixedKey, serializedValue);
      }

    } catch (error) {
      console.error(`[Redis] SET error for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Установить несколько значений одновременно
   */
  async setMany<T>(entries: Array<[string, T]>, options?: CacheSetOptions): Promise<void> {
    if (entries.length === 0) return;

    try {
      const pipeline = this.client.pipeline();

      for (const [key, value] of entries) {
        const prefixedKey = this.addPrefix(key);
        const serializedValue = JSON.stringify(value);

        if (options?.ttlSeconds) {
          pipeline.setex(prefixedKey, options.ttlSeconds, serializedValue);
        } else {
          pipeline.set(prefixedKey, serializedValue);
        }
      }

      await pipeline.exec();
      this.totalOperations += entries.length;

    } catch (error) {
      this.logger?.error('[Redis] SET MANY error', { error: String(error) });
      throw error;
    }
  }

  /**
   * Удалить значение из кэша
   */
  async delete(key: string): Promise<boolean> {
    try {
      const prefixedKey = this.addPrefix(key);
      const result = await this.client.del(prefixedKey);
      this.totalOperations++;
      return result > 0;
    } catch (error) {
      console.error(`[Redis] DELETE error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Удалить несколько значений одновременно
   */
  async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    try {
      const prefixedKeys = keys.map(key => this.addPrefix(key));
      const result = await this.client.del(...prefixedKeys);
      this.totalOperations += keys.length;
      return result;
    } catch (error) {
      console.error(`[Redis] DELETE MANY error:`, error);
      return 0;
    }
  }

  /**
   * Проверить существование ключа
   */
  async exists(key: string): Promise<boolean> {
    try {
      const prefixedKey = this.addPrefix(key);
      const result = await this.client.exists(prefixedKey);
      this.totalOperations++;
      return result > 0;
    } catch (error) {
      console.error(`[Redis] EXISTS error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Проверить существование нескольких ключей
   */
  async existsMany(keys: string[]): Promise<boolean[]> {
    if (keys.length === 0) return [];

    try {
      const prefixedKeys = keys.map(key => this.addPrefix(key));
      const results = await this.client.exists(...prefixedKeys);
      this.totalOperations += keys.length;

      // Redis EXISTS возвращает число, нужно преобразовать в массив булевых значений
      return prefixedKeys.map((_, index) => (results & (1 << index)) !== 0);

    } catch (error) {
      console.error(`[Redis] EXISTS MANY error:`, error);
      return new Array(keys.length).fill(false);
    }
  }

  /**
   * Увеличить числовое значение
   */
  async increment(key: string, increment: number = 1): Promise<number> {
    try {
      const prefixedKey = this.addPrefix(key);
      const result = await this.client.incrbyfloat(prefixedKey, increment);
      this.totalOperations++;
      return parseFloat(result);
    } catch (error) {
      console.error(`[Redis] INCREMENT error for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Получить информацию о ключе
   */
  async getKeyInfo(key: string): Promise<CacheKeyInfo | null> {
    try {
      const prefixedKey = this.addPrefix(key);
      const pipeline = this.client.pipeline();

      pipeline.exists(prefixedKey);
      pipeline.ttl(prefixedKey);
      pipeline.memory('USAGE', prefixedKey);

      const results = await pipeline.exec();
      if (!results || results[0][1] === 0) return null;

      const ttl = results[1][1] as number;
      const sizeBytes = results[2][1] as number | null;

      return {
        key,
        setAt: now(), // Приближенное время
        ttlSeconds: ttl > 0 ? ttl : undefined,
        sizeBytes: sizeBytes || undefined,
      };

    } catch (error) {
      console.error(`[Redis] GET KEY INFO error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Найти ключи по паттерну
   */
  async scanKeys(options?: CacheScanOptions): Promise<CacheScanResult> {
    try {
      const pattern = options?.pattern ? this.addPrefix(options.pattern) : '*';
      const limit = options?.limit || 100;

      const keys: string[] = [];
      let cursor = '0';

      do {
        const result = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', limit);
        cursor = result[0];
        const batchKeys = result[1];

        // Убираем префикс из ключей
        const cleanKeys = batchKeys.map(key => this.removePrefix(key));
        keys.push(...cleanKeys);

        if (options?.limit && keys.length >= options.limit) {
          keys.splice(options.limit);
          break;
        }
      } while (cursor !== '0');

      return {
        keys,
        totalCount: keys.length
      };

    } catch (error) {
      this.logger?.error('[Redis] SCAN error', { error: String(error) });
      return {
        keys: [],
        totalCount: 0
      };
    }
  }

  /**
   * Очистить весь кэш
   */
  async clear(): Promise<void> {
    try {
      if (this.keyPrefix) {
        // Удалить только ключи с префиксом
        const keys = await this.scanKeys({ pattern: '*' });
        if (keys.keys.length > 0) {
          await this.deleteMany(keys.keys);
        }
      } else {
        await this.client.flushdb();
      }
    } catch (error) {
      console.error(`[Redis] CLEAR error:`, error);
      throw error;
    }
  }

  /**
   * Получить статистику кэша
   */
  async getStats(): Promise<CacheStats> {
    try {
      const info = await this.client.info('stats');
      const dbSize = await this.client.dbsize();

      return {
        totalKeys: dbSize,
        hits: this.hits,
        misses: this.misses,
        hitRate: this.totalOperations > 0 ? this.hits / this.totalOperations : 0,
        totalSizeBytes: 0, // Redis не предоставляет общий размер
        averageValueSizeBytes: 0, // Требует дополнительного сканирования
      };

    } catch (error) {
      console.error(`[Redis] STATS error:`, error);
      return {
        totalKeys: 0,
        hits: this.hits,
        misses: this.misses,
        hitRate: 0,
        totalSizeBytes: 0,
        averageValueSizeBytes: 0,
      };
    }
  }

  /**
   * Проверить доступность Redis
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Закрыть соединение
   */
   async close(): Promise<void> {
    // Symmetric unsubscription — prevents EventEmitter listener leaks (OOM-008)
    this.client.off('connect', this.onConnect);
    this.client.off('error', this.onError);
    this.client.off('ready', this.onReady);
    await this.client.quit();
  }

  /**
   * Установить соединение с Redis
   */
  async connect(): Promise<void> {
    // ioredis connects automatically in constructor
    // This method exists for compatibility with expected interface
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
  }

  /**
   * Разорвать соединение с Redis
   */
  async disconnect(): Promise<void> {
    await this.close();
  }

  // ── List operations ───────────────────────────────────────────

  async pushList(key: string, value: unknown): Promise<number> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return this.client.rpush(this.addPrefix(key), serialized);
  }

  async popList(key: string): Promise<unknown | null> {
    try {
      const raw = await this.client.lpop(this.addPrefix(key));
      if (raw === null) return null;
      const parsed = tryJsonParse(raw);
      return parsed.ok ? parsed.value : raw;
    } catch {
      return null;
    }
  }

  async getListRange(key: string, start: number, stop: number): Promise<unknown[]> {
    try {
      const items = await this.client.lrange(this.addPrefix(key), start, stop);
      return items.map((item: string) => {
        const parsed = tryJsonParse(item);
        return parsed.ok ? parsed.value : item;
      });
    } catch {
      return [];
    }
  }

  async getListLength(key: string): Promise<number> {
    try {
      return await this.client.llen(this.addPrefix(key));
    } catch {
      return 0;
    }
  }
}

/**
 * Фабричная функция для создания Redis адаптера
 */
export function createRedisAdapter(config?: RedisAdapterConfig): ICache {
  return new RedisAdapter(config);
}

/**
 * Фабричная функция для создания Redis адаптера из конфигурации приложения
 */
export function createRedisAdapterFromEnv(): ICache {
  const hostFromConfig = readStr('REDIS_HOST');
  const portFromConfig = readInt('REDIS_PORT', 6379);
  const password = readStr('REDIS_PASSWORD');
  const dbFromConfig = readInt('REDIS_DB', 0);
  const keyPrefix = readStr('REDIS_KEY_PREFIX');
  const cluster = readBool('REDIS_CLUSTER', false);
  const enableMetrics = readBool('REDIS_ENABLE_METRICS', true);

  const host = hostFromConfig ?? 'localhost';
  const port = portFromConfig ?? 6379;
  const db = dbFromConfig ?? 0;

  return new RedisAdapter({
    host,
    port,
    password,
    db,
    keyPrefix: keyPrefix ?? undefined,
    cluster,
    enableMetrics,
  });
}