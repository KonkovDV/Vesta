/**
 * ICache - интерфейс для работы с кэшем
 * Layer: Domain (бизнес-логика)
 *
 * Определяет контракт для кэширования данных.
 * Следует принципу Dependency Inversion - Domain не зависит от конкретного кэш провайдера.
 *
 * @example
 * ```typescript
 * // Application Layer использует интерфейс
 * class UserService {
 *   constructor(private cache: ICache) {}
 *
 *   async getUser(id: string): Promise<User> {
 *     const cacheKey = `user:${id}`;
 *
 *     // Попытка получить из кэша
 *     const cached = await this.cache.get<User>(cacheKey);
 *     if (cached) {
 *       return cached;
 *     }
 *
 *     // Загрузка из базы данных
 *     const user = await this.userRepository.findById(id);
 *
 *     // Сохранение в кэш
 *     await this.cache.set(cacheKey, user, 300); // 5 минут
 *
 *     return user;
 *   }
 * }
 * ```
 */

import { Timestamp } from '../../core/types';

/**
 * Опции для установки значения в кэш
 */
export interface CacheSetOptions {
  /** Время жизни в секундах */
  ttlSeconds?: number;
  /** Условная установка (только если ключ не существует) */
  onlyIfNotExists?: boolean;
  /** Условная установка (только если ключ существует) */
  onlyIfExists?: boolean;
}

/**
 * Результат получения значения из кэша
 */
export interface CacheGetResult<T> {
  /** Значение из кэша */
  value: T;
  /** Время установки в кэш */
  cachedAt: Timestamp;
  /** Оставшееся время жизни в секундах */
  ttlRemainingSeconds?: number;
  /** Метаданные кэширования */
  metadata?: Record<string, unknown>;
}

/**
 * Информация о ключе кэша
 */
export interface CacheKeyInfo {
  /** Ключ */
  key: string;
  /** Время установки */
  setAt: Timestamp;
  /** Время жизни в секундах */
  ttlSeconds?: number;
  /** Размер значения в байтах */
  sizeBytes?: number;
  /** Тип значения */
  valueType?: string;
}

/**
 * Статистика кэша
 */
export interface CacheStats {
  /** Общее количество ключей */
  totalKeys: number;
  /** Количество попаданий */
  hits: number;
  /** Количество промахов */
  misses: number;
  /** Процент попаданий */
  hitRate: number;
  /** Общий размер кэша в байтах */
  totalSizeBytes: number;
  /** Средний размер значения в байтах */
  averageValueSizeBytes: number;
  /** Время последней очистки */
  lastEvictionAt?: Timestamp;
}

/**
 * Опции для поиска ключей
 */
export interface CacheScanOptions {
  /** Паттерн для поиска (glob-style) */
  pattern?: string;
  /** Максимальное количество результатов */
  limit?: number;
  /** Смещение для пагинации */
  offset?: number;
}

/**
 * Результат поиска ключей
 */
export interface CacheScanResult {
  /** Найденные ключи */
  keys: string[];
  /** Курсор для продолжения поиска */
  cursor?: string;
  /** Общее количество найденных ключей */
  totalCount: number;
}

/**
 * ICache - интерфейс для кэширования данных
 *
 * Определяет операции для работы с кэшем без привязки к конкретному провайдеру.
 * Реализация этого интерфейса будет в Infrastructure слое и может использовать:
 * - Redis
 * - Memcached
 * - In-memory cache
 * - Distributed cache
 * - No-op cache для тестов
 */
export interface ICache {
  /**
   * Получить значение из кэша
   *
   * @param key - Ключ
   * @returns Значение или null если ключ не найден
   *
   * @example
   * ```typescript
   * const user = await cache.get<User>('user:123');
   * if (user) {
   *   console.log('Пользователь найден в кэше:', user.name);
   * } else {
   *   console.log('Пользователь не найден в кэше');
   * }
   * ```
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Получить значение с дополнительной информацией
   *
   * @param key - Ключ
   * @returns Подробная информация о кэшированном значении
   *
   * @example
   * ```typescript
   * const result = await cache.getWithInfo<User>('user:123');
   * if (result) {
   *   console.log(`Пользователь кэширован ${result.ttlRemainingSeconds} сек назад`);
   *   return result.value;
   * }
   * ```
   */
  getWithInfo<T>(key: string): Promise<CacheGetResult<T> | null>;

  /**
   * Установить значение в кэш
   *
   * @param key - Ключ
   * @param value - Значение
   * @param options - Опции установки
   *
   * @example
   * ```typescript
   * // Кэшировать на 5 минут
   * await cache.set('user:123', userData, { ttlSeconds: 300 });
   *
   * // Установить только если ключ не существует
   * await cache.set('lock:key', 'locked', { onlyIfNotExists: true, ttlSeconds: 60 });
   * ```
   */
  set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>;

  /**
   * Установить несколько значений одновременно
   *
   * @param entries - Массив пар ключ-значение
   * @param options - Опции установки (применяются ко всем)
   *
   * @example
   * ```typescript
   * await cache.setMany([
   *   ['user:123', userData],
   *   ['user:456', userData2]
   * ], { ttlSeconds: 300 });
   * ```
   */
  setMany<T>(entries: Array<[string, T]>, options?: CacheSetOptions): Promise<void>;

  /**
   * Удалить значение из кэша
   *
   * @param key - Ключ для удаления
   * @returns true если ключ был удален
   *
   * @example
   * ```typescript
   * const deleted = await cache.delete('user:123');
   * console.log(deleted ? 'Ключ удален' : 'Ключ не найден');
   * ```
   */
  delete(key: string): Promise<boolean>;

  /**
   * Удалить несколько значений одновременно
   *
   * @param keys - Ключи для удаления
   * @returns Количество удаленных ключей
   *
   * @example
   * ```typescript
   * const deletedCount = await cache.deleteMany(['user:123', 'user:456']);
   * console.log(`Удалено ${deletedCount} ключей`);
   * ```
   */
  deleteMany(keys: string[]): Promise<number>;

  /**
   * Проверить существование ключа
   *
   * @param key - Ключ для проверки
   * @returns true если ключ существует
   *
   * @example
   * ```typescript
   * if (await cache.exists('user:123')) {
   *   console.log('Пользователь кэширован');
   * }
   * ```
   */
  exists(key: string): Promise<boolean>;

  /**
   * Проверить существование нескольких ключей
   *
   * @param keys - Ключи для проверки
   * @returns Массив результатов проверки
   *
   * @example
   * ```typescript
   * const results = await cache.existsMany(['user:123', 'user:456']);
   * console.log('user:123 существует:', results[0]);
   * console.log('user:456 существует:', results[1]);
   * ```
   */
  existsMany(keys: string[]): Promise<boolean[]>;

  /**
   * Увеличить числовое значение
   *
   * @param key - Ключ
   * @param increment - Значение инкремента (по умолчанию 1)
   * @returns Новое значение
   *
   * @example
   * ```typescript
   * const newValue = await cache.increment('counter:page_views', 1);
   * console.log(`Просмотров страницы: ${newValue}`);
   * ```
   */
  increment(key: string, increment?: number): Promise<number>;

  /**
   * Получить информацию о ключе
   *
   * @param key - Ключ
   * @returns Информация о ключе или null
   */
  getKeyInfo(key: string): Promise<CacheKeyInfo | null>;

  /**
   * Найти ключи по паттерну
   *
   * @param options - Опции поиска
   * @returns Результаты поиска
   *
   * @example
   * ```typescript
   * // Найти все ключи пользователей
   * const result = await cache.scanKeys({ pattern: 'user:*', limit: 100 });
   * console.log(`Найдено ${result.keys.length} пользователей`);
   * ```
   */
  scanKeys(options?: CacheScanOptions): Promise<CacheScanResult>;

  /**
   * Очистить весь кэш
   *
   * @example
   * ```typescript
   * await cache.clear();
   * console.log('Кэш очищен');
   * ```
   */
  clear(): Promise<void>;

  /**
   * Получить статистику кэша
   *
   * @returns Статистика использования кэша
   */
  getStats(): Promise<CacheStats>;

  /**
   * Проверить доступность кэша
   *
   * @returns true если кэш доступен
   */
  isAvailable(): Promise<boolean>;

  /**
   * Закрыть соединение с кэшем
   *
   * Освобождает ресурсы подключения. Должен вызываться при завершении работы.
   *
   * @example
   * ```typescript
   * await cache.disconnect();
   * console.log('Соединение с кэшем закрыто');
   * ```
   */
  disconnect(): Promise<void>;
}