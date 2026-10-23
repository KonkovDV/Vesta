/**
 * Config Validator - валидация конфигурации сервисов
 * Layer: Core
 */

import type { AppConfig } from '../../config/schema';
import { getConfig } from '../../config';

export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

function getString(
  config: AppConfig,
  key: keyof AppConfig,
  fallback?: string,
): string | undefined {
  const value = config[key];
  if (typeof value !== 'string' || value === '') {
    return fallback;
  }
  return value;
}

function getInt(config: AppConfig, key: keyof AppConfig): number | null {
  const value = config[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * Валидация конфигурации Event Store
 */
export function validateEventStoreConfig(
  configOverride?: AppConfig,
): ConfigValidationResult {
  const config = configOverride ?? getConfig();
  const errors: string[] = [];
  const warnings: string[] = [];

  const hasDbHost = getString(config, 'DB_HOST') !== undefined;
  const hasDatabaseUrl = getString(config, 'DATABASE_URL') !== undefined;

  if (!hasDbHost && !hasDatabaseUrl) {
    errors.push('DB_HOST or DATABASE_URL is required for Event Store');
  }
  const hasDbName = getString(config, 'DB_NAME') !== undefined;
  if (!hasDbName && !hasDatabaseUrl) {
    errors.push('DB_NAME or DATABASE_URL is required for Event Store');
  }
  const hasDbUser = getString(config, 'DB_USER') !== undefined;
  if (!hasDbUser && !hasDatabaseUrl) {
    errors.push('DB_USER or DATABASE_URL is required for Event Store');
  }
  const hasDbPassword = getString(config, 'DB_PASSWORD') !== undefined;
  if (!hasDbPassword && !hasDatabaseUrl) {
    errors.push('DB_PASSWORD or DATABASE_URL is required for Event Store');
  }

  const databaseUrl = getString(config, 'DATABASE_URL');
  if (databaseUrl !== undefined) {
    try {
      const url = new URL(databaseUrl);
      if (!url.protocol.startsWith('postgres')) {
        errors.push(
          'DATABASE_URL must be a valid PostgreSQL connection string (protocol must be postgresql:// or postgres://)',
        );
      }
    } catch {
      errors.push('DATABASE_URL must be a valid URL');
    }
  }

  const port = getInt(config, 'DB_PORT');
  if (port !== null && (port < 1 || port > 65535)) {
    errors.push('DB_PORT must be a valid number between 1 and 65535');
  }

  const schema = getString(config, 'EVENT_STORE_SCHEMA', 'event_store');
  if (schema !== undefined && schema.length > 63) {
    warnings.push('EVENT_STORE_SCHEMA should not exceed 63 characters');
  }

  const eventsTable = getString(config, 'EVENT_STORE_EVENTS_TABLE', 'events');
  if (eventsTable !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(eventsTable)) {
    errors.push('EVENT_STORE_EVENTS_TABLE must be a valid PostgreSQL table name');
  }

  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Валидация конфигурации Event Bus
 */
export function validateEventBusConfig(
  configOverride?: AppConfig,
): ConfigValidationResult {
  const config = configOverride ?? getConfig();
  const errors: string[] = [];
  const warnings: string[] = [];

  const redisHost = getString(config, 'REDIS_HOST');
  if (!redisHost || redisHost.trim() === '') {
    errors.push('REDIS_HOST is required for Event Bus and cannot be empty');
  }

  if (redisHost && !/^[a-zA-Z0-9.\-:]+$/.test(redisHost)) {
    warnings.push('REDIS_HOST contains potentially invalid characters');
  }

  const redisPort = getInt(config, 'REDIS_PORT');
  if (redisPort !== null && (redisPort < 1 || redisPort > 65535)) {
    errors.push('REDIS_PORT must be a valid number between 1 and 65535');
  }

  const batchSize = getInt(config, 'REDIS_BATCH_SIZE');
  if (batchSize !== null && (batchSize < 1 || batchSize > 1000)) {
    warnings.push('REDIS_BATCH_SIZE should be between 1 and 1000');
  }

  const defaultTimeoutMs = getInt(config, 'REDIS_DEFAULT_TIMEOUT_MS');
  if (
    defaultTimeoutMs !== null &&
    (defaultTimeoutMs < 100 || defaultTimeoutMs > 60000)
  ) {
    warnings.push('REDIS_DEFAULT_TIMEOUT_MS should be between 100 and 60000 ms');
  }

  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Валидация конфигурации Outbox
 */
export function validateOutboxConfig(
  configOverride?: AppConfig,
): ConfigValidationResult {
  const config = configOverride ?? getConfig();
  const errors: string[] = [];
  const warnings: string[] = [];

  const eventStoreValidation = validateEventStoreConfig(config);
  if (!eventStoreValidation.isValid) {
    errors.push(...eventStoreValidation.errors);
  }
  warnings.push(...eventStoreValidation.warnings);

  const maxRetriesValue = getInt(config, 'OUTBOX_MAX_RETRIES');
  const maxRetries = maxRetriesValue === null ? 3 : maxRetriesValue;
  if (maxRetries < 0 || maxRetries > 10) {
    errors.push('OUTBOX_MAX_RETRIES must be a number between 0 and 10');
  }

  const retryDelayMsValue = getInt(config, 'OUTBOX_RETRY_DELAY_MS');
  const retryDelayMs = retryDelayMsValue === null ? 1000 : retryDelayMsValue;
  if (retryDelayMs < 100 || retryDelayMs > 60000) {
    warnings.push('OUTBOX_RETRY_DELAY_MS should be between 100 and 60000 ms');
  }

  const batchSizeValue = getInt(config, 'OUTBOX_BATCH_SIZE');
  const batchSize = batchSizeValue === null ? 10 : batchSizeValue;
  if (batchSize < 1 || batchSize > 100) {
    warnings.push('OUTBOX_BATCH_SIZE should be between 1 and 100');
  }

  const processingIntervalValue = getInt(config, 'OUTBOX_PROCESSING_INTERVAL_MS');
  const processingIntervalMs =
    processingIntervalValue === null ? 5000 : processingIntervalValue;
  if (processingIntervalMs < 100 || processingIntervalMs > 60000) {
    warnings.push(
      'OUTBOX_PROCESSING_INTERVAL_MS should be between 100 and 60000 ms',
    );
  }

  const schema = getString(config, 'OUTBOX_SCHEMA', 'outbox');
  if (schema !== undefined && schema.length > 63) {
    warnings.push('OUTBOX_SCHEMA should not exceed 63 characters');
  }

  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Валидация всех event-сервисов
 */
export function validateAllEventServices(
  configOverride?: AppConfig,
): ConfigValidationResult {
  const config = configOverride ?? getConfig();

  const errors: string[] = [];
  const warnings: string[] = [];

  const eventStoreValidation = validateEventStoreConfig(config);
  const eventBusValidation = validateEventBusConfig(config);
  const outboxValidation = validateOutboxConfig(config);

  errors.push(
    ...eventStoreValidation.errors,
    ...eventBusValidation.errors,
    ...outboxValidation.errors,
  );
  warnings.push(
    ...eventStoreValidation.warnings,
    ...eventBusValidation.warnings,
    ...outboxValidation.warnings,
  );

  return { isValid: errors.length === 0, errors, warnings };
}