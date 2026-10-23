/**
 * ApiKeyService - безопасное хранилище API-ключей.
 * Layer: Application
 *
 * Задачи:
 * - генерация криптографически стойких API-ключей;
 * - хранение только хэшей ключей в БД (через IApiKeyRepository);
 * - валидация и отзыв ключей;
 * - опциональное кэширование метаданных ключа через ICache (Redis/in-memory).
 */

import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import type {
  IApiKeyRepository,
  StoredApiKey,
  CreateApiKeyParams,
} from '../../domain/auth/IApiKeyRepository';
import type { ICache } from '../../domain/cache/ICache';

export interface ValidatedApiKey {
  keyId: string;
  ownerId: string;
  tenantId: string | null;
  scopes: readonly string[];
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

interface CachedApiKey {
  id: string;
  prefix: string;
  hash: string;
  ownerId: string;
  tenantId: string | null;
  scopes: string[];
  expiresAtMs: number | null;
  revokedAtMs: number | null;
}

export interface CreateKeyOptions {
  tenantId?: string | null;
  scopes?: readonly string[];
  expiresAt?: Date | null;
}

const SCRYPT_KEY_LENGTH = 64;
const SALT_LENGTH_BYTES = 16;
const API_KEY_PREFIX = 'sk_';
const PREFIX_LENGTH = 10;
const DEFAULT_TTL_DAYS = 90;
const MS_PER_DAY = 86_400_000;

export class ApiKeyService {
  private readonly repository: IApiKeyRepository;
  private readonly cache?: ICache;
  private readonly cacheNamespace = 'auth:api_keys';
  private readonly cacheTtlSeconds = 300;

  constructor(repository: IApiKeyRepository, cache?: ICache) {
    this.repository = repository;
    this.cache = cache;
  }

  /**
   * Создать новый API ключ для ownerId.
   * Возвращает raw ключ, который показывается только один раз.
   */
  async createKey(ownerId: string, options?: CreateKeyOptions): Promise<string> {
    const trimmedOwnerId = ownerId.trim();
    if (trimmedOwnerId.length === 0) {
      throw new Error('ownerId must be a non-empty string');
    }

    const rawKey = this.generateRawKey();
    const prefix = this.getPrefix(rawKey);
    const hash = this.hashKey(rawKey);

    const params: CreateApiKeyParams = {
      id: randomUUID(),
      prefix,
      hash,
      ownerId: trimmedOwnerId,
      tenantId: options?.tenantId ?? null,
      scopes: options?.scopes ?? [],
      expiresAt: options?.expiresAt !== undefined
        ? options.expiresAt
        : new Date(Date.now() + DEFAULT_TTL_DAYS * MS_PER_DAY),
    };

    const stored = await this.repository.create(params);
    await this.storeInCache(stored);
    return rawKey;
  }

  /**
   * Зарегистрировать уже существующий raw API-ключ (например, из конфигурации).
   * Сохраняет только хэш и метаданные в хранилище.
   */
  async registerExistingKey(
    ownerId: string,
    rawKey: string,
    options?: CreateKeyOptions,
  ): Promise<ValidatedApiKey> {
    const trimmedOwnerId = ownerId.trim();
    const trimmedKey = rawKey.trim();

    if (trimmedOwnerId.length === 0) {
      throw new Error('ownerId must be a non-empty string');
    }
    if (trimmedKey.length === 0) {
      throw new Error('rawKey must be a non-empty string');
    }

    const prefix = this.getPrefix(trimmedKey);
    const hash = this.hashKey(trimmedKey);

    const params: CreateApiKeyParams = {
      id: randomUUID(),
      prefix,
      hash,
      ownerId: trimmedOwnerId,
      tenantId: options?.tenantId ?? null,
      scopes: options?.scopes ?? [],
      expiresAt: options?.expiresAt ?? null,
    };

    const stored = await this.repository.create(params);
    await this.storeInCache(stored);

    return {
      keyId: stored.id,
      ownerId: stored.ownerId,
      tenantId: stored.tenantId ?? null,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt ?? null,
      revokedAt: stored.revokedAt ?? null,
    };
  }

  /**
   * Валидация сырого ключа.
   * Возвращает метаданные ключа или null, если ключ не найден/истёк/отозван/хэш не совпал.
   */
  async validate(rawKey: string): Promise<ValidatedApiKey | null> {
    const normalized = rawKey.trim();
    if (normalized.length === 0) {
      return null;
    }

    const prefix = this.getPrefix(normalized);
    const candidate = await this.getByPrefix(prefix);
    if (!candidate) {
      return null;
    }

    if (this.isExpired(candidate) || this.isRevoked(candidate)) {
      return null;
    }

    const isMatch = this.verifyKey(normalized, candidate.hash);
    if (!isMatch) {
      return null;
    }

    return {
      keyId: candidate.id,
      ownerId: candidate.ownerId,
      tenantId: candidate.tenantId ?? null,
      scopes: candidate.scopes,
      expiresAt: candidate.expiresAt ?? null,
      revokedAt: candidate.revokedAt ?? null,
    };
  }

  /**
   * Отзыв ключа по сырому значению.
   * Безопасно при повторных вызовах и для несуществующих ключей.
   */
  async revoke(rawKey: string): Promise<void> {
    const normalized = rawKey.trim();
    if (normalized.length === 0) {
      return;
    }

    const prefix = this.getPrefix(normalized);
    const candidate = await this.getByPrefix(prefix);
    if (!candidate) {
      return;
    }

    const isMatch = this.verifyKey(normalized, candidate.hash);
    if (!isMatch) {
      return;
    }

    const now = new Date();
    await this.repository.revokeById(candidate.id, now);
    await this.evictFromCache(candidate.prefix);
  }

  /**
   * Rotate an existing key: revoke old, create new for the same owner.
   * Returns the new raw key (shown only once).
   */
  async rotateKey(rawKey: string, options?: CreateKeyOptions): Promise<string> {
    const validated = await this.validate(rawKey);
    if (!validated) {
      throw new Error('Cannot rotate: key is invalid, expired, or already revoked');
    }
    await this.revoke(rawKey);
    return this.createKey(validated.ownerId, {
      tenantId: options?.tenantId ?? validated.tenantId,
      scopes: options?.scopes ?? validated.scopes,
      expiresAt: options?.expiresAt,
    });
  }

  /**
   * Emergency: revoke ALL active keys for an owner (leak response).
   * Evicts all affected keys from cache.
   */
  async revokeAllForOwner(ownerId: string): Promise<number> {
    const keys = await this.repository.findByOwnerId(ownerId);
    const now = new Date();
    let count = 0;
    for (const key of keys) {
      if (!this.isRevoked(key)) {
        await this.repository.revokeById(key.id, now);
        await this.evictFromCache(key.prefix);
        count += 1;
      }
    }
    return count;
  }

  /** Batch-revoke all expired keys. Returns count of revoked keys. */
  async cleanupExpired(): Promise<number> {
    return this.repository.revokeExpired();
  }

  private generateRawKey(): string {
    const base = randomUUID().replace(/-/g, '');
    return `${API_KEY_PREFIX}${base}`;
  }

  private getPrefix(rawKey: string): string {
    return rawKey.substring(0, PREFIX_LENGTH);
  }

  private hashKey(rawKey: string): string {
    const salt = randomBytes(SALT_LENGTH_BYTES);
    const derivedKey = scryptSync(rawKey, salt, SCRYPT_KEY_LENGTH);
    const saltEncoded = salt.toString('base64');
    const hashEncoded = derivedKey.toString('base64');
    return `${saltEncoded}:${hashEncoded}`;
  }

  private verifyKey(rawKey: string, storedHash: string): boolean {
    const parts = storedHash.split(':');
    if (parts.length !== 2) {
      return false;
    }

    const [saltEncoded, hashEncoded] = parts;
    if (saltEncoded.length === 0 || hashEncoded.length === 0) {
      return false;
    }

    const salt = Buffer.from(saltEncoded, 'base64');
    const expected = Buffer.from(hashEncoded, 'base64');
    const derived = scryptSync(rawKey, salt, SCRYPT_KEY_LENGTH);

    // Constant-time comparison to prevent timing side-channel attacks (OWASP Auth CS §4.3.4)
    if (derived.length !== expected.length) {
      // Still perform a dummy comparison to avoid leaking length information via timing
      const dummy = Buffer.alloc(derived.length);
      timingSafeEqual(derived, dummy);
      return false;
    }

    return timingSafeEqual(derived, expected);
  }

  private isExpired(key: StoredApiKey): boolean {
    if (!key.expiresAt) {
      return false;
    }
    return key.expiresAt.getTime() <= Date.now();
  }

  private isRevoked(key: StoredApiKey): boolean {
    if (!key.revokedAt) {
      return false;
    }
    return key.revokedAt.getTime() <= Date.now();
  }

  private async getByPrefix(prefix: string): Promise<StoredApiKey | null> {
    const cached = await this.getFromCache(prefix);
    if (cached) {
      return cached;
    }

    const fromRepo = await this.repository.findByPrefix(prefix);
    if (!fromRepo) {
      return null;
    }

    await this.storeInCache(fromRepo);
    return fromRepo;
  }

  private cacheKey(prefix: string): string {
    return `${this.cacheNamespace}:prefix:${prefix}`;
  }

  private toCached(key: StoredApiKey): CachedApiKey {
    return {
      id: key.id,
      prefix: key.prefix,
      hash: key.hash,
      ownerId: key.ownerId,
      tenantId: key.tenantId ?? null,
      scopes: [...key.scopes],
      expiresAtMs: key.expiresAt ? key.expiresAt.getTime() : null,
      revokedAtMs: key.revokedAt ? key.revokedAt.getTime() : null,
    };
  }

  private fromCached(value: CachedApiKey): StoredApiKey {
    const expiresAt = value.expiresAtMs !== null ? new Date(value.expiresAtMs) : null;
    const revokedAt = value.revokedAtMs !== null ? new Date(value.revokedAtMs) : null;

    return {
      id: value.id,
      prefix: value.prefix,
      hash: value.hash,
      ownerId: value.ownerId,
      tenantId: value.tenantId,
      scopes: value.scopes,
      expiresAt,
      createdAt: new Date(0),
      revokedAt,
    };
  }

  private async storeInCache(key: StoredApiKey): Promise<void> {
    if (!this.cache) {
      return;
    }
    const cacheKey = this.cacheKey(key.prefix);
    const cached = this.toCached(key);
    await this.cache.set<CachedApiKey>(cacheKey, cached, { ttlSeconds: this.cacheTtlSeconds });
  }

  private async getFromCache(prefix: string): Promise<StoredApiKey | null> {
    if (!this.cache) {
      return null;
    }
    const key = this.cacheKey(prefix);
    const cached = await this.cache.get<CachedApiKey>(key);
    if (!cached) {
      return null;
    }
    return this.fromCached(cached);
  }

  private async evictFromCache(prefix: string): Promise<void> {
    if (!this.cache) {
      return;
    }
    const key = this.cacheKey(prefix);
    await this.cache.delete(key);
  }
}