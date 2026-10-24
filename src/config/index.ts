import dotenv from 'dotenv';
import { AppConfigSchema as ConfigSchema } from './schema';
import type { AppConfig } from './schema';
export * from './schema/definitions/identity.schema';
export * from './schema/definitions/physics.schema';
export * from './schema/definitions/sandbox.schema';
export * from './schema/definitions/safety.schema';


dotenv.config();

/** Host, port, user, password and database from a postgres URL. Empty when the URL is absent or invalid. */
export function postgresPartsFromUrl(url: string | undefined): {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
} {
  if (!url) {
    return {};
  }
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, '');
    return {
      host: parsed.hostname || undefined,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : undefined,
      user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      database: database || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Загружает и валидирует конфигурацию из переданного env (по умолчанию process.env).
 *
 * Валидация:
 * - Использует Zod-схему ConfigSchema.
 * - При ошибке логирует подробный формат и выбрасывает Error.
 *   Обработчик верхнего уровня (entrypoint/orchestrator) обязан завершить процесс.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const database = postgresPartsFromUrl(env.DATABASE_URL);

  const inputObj = {
      // Map raw env to nested structure expected by AppConfigSchema
      env: env.JEST_WORKER_ID ? 'test' : env.NODE_ENV,
      NODE_ENV: env.JEST_WORKER_ID ? 'test' : env.NODE_ENV,
      PORT: env.PORT ? parseInt(env.PORT) : undefined,
      LOG_LEVEL: env.LOG_LEVEL,
      DEBUG: env.DEBUG === 'true',
      INFRA_INIT_TIMEOUT_MS: env.INFRA_INIT_TIMEOUT_MS ? parseInt(env.INFRA_INIT_TIMEOUT_MS) : undefined,
      INFRA_LOG_INIT: env.INFRA_LOG_INIT,
      APP_LOG_INIT: env.APP_LOG_INIT,
      APP_BOOTSTRAP_FORCE: env.APP_BOOTSTRAP_FORCE,
      ENABLE_HTTP: env.ENABLE_HTTP,
      HTTP_LOG_START: env.HTTP_LOG_START,
      DATABASE_URL: env.DATABASE_URL,
      DB_HOST: env.DB_HOST,
      DB_PORT: env.DB_PORT,
      DB_NAME: env.DB_NAME,
      DB_USER: env.DB_USER,
      DB_PASSWORD: env.DB_PASSWORD,
      REDIS_HOST: env.REDIS_HOST,
      REDIS_PORT: env.REDIS_PORT,
      REDIS_PASSWORD: env.REDIS_PASSWORD,
      REDIS_DB: env.REDIS_DB ? parseInt(env.REDIS_DB) : undefined,
      OUTBOX_PORT: env.OUTBOX_PORT,
      SINGULARITY_BROWSER_WS_ENDPOINT: env.SINGULARITY_BROWSER_WS_ENDPOINT,
      SINGULARITY_BROWSER_HEADLESS: env.SINGULARITY_BROWSER_HEADLESS !== 'false',
      SINGULARITY_BROWSER_TIMEOUT_MS: env.SINGULARITY_BROWSER_TIMEOUT_MS ? parseInt(env.SINGULARITY_BROWSER_TIMEOUT_MS) : undefined,
      SINGULARITY_NAMESPACE: env.SINGULARITY_NAMESPACE,
      REQUEST_CONTEXT_MAX_AGE_MS: env.REQUEST_CONTEXT_MAX_AGE_MS,
      REQUEST_CONTEXT_STRICT_ROOT_CREATION: env.REQUEST_CONTEXT_STRICT_ROOT_CREATION,
      REQUEST_CONTEXT_MAX_METADATA_SIZE: env.REQUEST_CONTEXT_MAX_METADATA_SIZE,
      REQUEST_CONTEXT_MAX_EVENTS: env.REQUEST_CONTEXT_MAX_EVENTS,
      identity: {
          name: env.BOT_NAME,
          role: env.BOT_ROLE,
      },
      physics: {
          time: {
            tickRateMs: env.TICK_RATE_MS ? parseInt(env.TICK_RATE_MS) : undefined,
          },
          memory: {
              maxContextTokens: env.MAX_CONTEXT_TOKENS ? parseInt(env.MAX_CONTEXT_TOKENS) : undefined
          },
          safety: {
              hardCutoffPercent: env.SINGULARITY_CONTEXT_HARD_CUTOFF_PERCENT ? parseInt(env.SINGULARITY_CONTEXT_HARD_CUTOFF_PERCENT) : undefined,
              minMessagesAfterPrune: env.SINGULARITY_CONTEXT_MIN_MESSAGES ? parseInt(env.SINGULARITY_CONTEXT_MIN_MESSAGES) : undefined,
          }
      },
      sandbox: {
          sandboxRoot: env.SANDBOX_ROOT,
          containerImage: env.SANDBOX_IMAGE,
      },
      infra: {
          redis: {
              connection: {
                  host: env.REDIS_EVENT_BUS_HOST || env.REDIS_HOST,
                  port: (env.REDIS_EVENT_BUS_PORT || env.REDIS_PORT) ? parseInt(env.REDIS_EVENT_BUS_PORT || env.REDIS_PORT!) : undefined,
                  password: env.REDIS_EVENT_BUS_PASSWORD || env.REDIS_PASSWORD,
                  db: (env.REDIS_EVENT_BUS_DB || env.REDIS_DB) ? parseInt(env.REDIS_EVENT_BUS_DB || env.REDIS_DB!) : undefined,
                  retryDelayOnFailover: env.REDIS_RETRY_DELAY ? parseInt(env.REDIS_RETRY_DELAY) : undefined,
                  enableOfflineQueue: env.REDIS_ENABLE_OFFLINE_QUEUE !== 'false',
                  lazyConnect: env.REDIS_LAZY_CONNECT !== 'false',
                  maxRetriesPerRequest: env.REDIS_MAX_RETRIES ? parseInt(env.REDIS_MAX_RETRIES) : undefined,
                  tls: env.REDIS_TLS === 'true' ? {
                      rejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
                      ca: env.REDIS_TLS_CA,
                      cert: env.REDIS_TLS_CERT,
                      key: env.REDIS_TLS_KEY,
                  } : undefined,
              },
              keyPrefix: env.REDIS_EVENT_BUS_PREFIX,
              batchSize: env.REDIS_EVENT_BUS_BATCH_SIZE ? parseInt(env.REDIS_EVENT_BUS_BATCH_SIZE) : undefined,
              batchInterval: env.REDIS_EVENT_BUS_BATCH_INTERVAL ? parseInt(env.REDIS_EVENT_BUS_BATCH_INTERVAL) : undefined,
              defaultTimeoutMs: env.REDIS_EVENT_BUS_DEFAULT_TIMEOUT ? parseInt(env.REDIS_EVENT_BUS_DEFAULT_TIMEOUT) : undefined,
              defaultMaxRetries: env.REDIS_EVENT_BUS_DEFAULT_RETRIES ? parseInt(env.REDIS_EVENT_BUS_DEFAULT_RETRIES) : undefined,
              retryDelayMs: env.REDIS_EVENT_BUS_RETRY_DELAY ? parseInt(env.REDIS_EVENT_BUS_RETRY_DELAY) : undefined,
              enableDeadLetterQueue: env.REDIS_EVENT_BUS_DLQ !== 'false',
              deadLetterQueueMaxSize: env.REDIS_EVENT_BUS_DLQ_MAX_SIZE ? parseInt(env.REDIS_EVENT_BUS_DLQ_MAX_SIZE) : undefined,
              enableMetrics: env.REDIS_EVENT_BUS_METRICS !== 'false',
              metricsInterval: env.REDIS_EVENT_BUS_METRICS_INTERVAL ? parseInt(env.REDIS_EVENT_BUS_METRICS_INTERVAL) : undefined,
          },
          database: {
              connectionString: env.DATABASE_URL,
              ssl: env.DB_SSL === 'true',
              max: env.DB_MAX_CONNECTIONS ? parseInt(env.DB_MAX_CONNECTIONS) : undefined,
              idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS ? parseInt(env.DB_IDLE_TIMEOUT_MS) : undefined,
              connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS ? parseInt(env.DB_CONNECTION_TIMEOUT_MS) : undefined,
              enableQueryLogging: env.DB_ENABLE_QUERY_LOGGING === 'true',
              enableMetrics: env.DB_ENABLE_METRICS !== 'false',
          },
          outbox: {
              connection: {
                  host: env.OUTBOX_HOST || env.EVENT_STORE_HOST || database.host,
                  port: (env.OUTBOX_PORT || env.EVENT_STORE_PORT) ? parseInt(env.OUTBOX_PORT || env.EVENT_STORE_PORT!) : database.port,
                  user: env.OUTBOX_USER || env.EVENT_STORE_USER || database.user,
                  password: env.OUTBOX_PASSWORD || env.EVENT_STORE_PASSWORD || database.password,
                  database: env.OUTBOX_DATABASE || env.EVENT_STORE_DATABASE || database.database,
                  // TLS without certificate checks is open to a man in the middle. The
                  // system CAs verify by default; DB_SSL_REJECT_UNAUTHORIZED=false opts out.
                  ssl: env.OUTBOX_SSL === 'true'
                    ? { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
                    : undefined,
              },
              schema: env.OUTBOX_SCHEMA,
              outboxTable: env.OUTBOX_TABLE,
              dlqTable: env.OUTBOX_DLQ_TABLE,
              poolSize: env.OUTBOX_POOL_SIZE ? parseInt(env.OUTBOX_POOL_SIZE) : undefined,
              maxRetries: env.OUTBOX_MAX_RETRIES ? parseInt(env.OUTBOX_MAX_RETRIES) : undefined,
              retryDelayMs: env.OUTBOX_RETRY_DELAY_MS ? parseInt(env.OUTBOX_RETRY_DELAY_MS) : undefined,
              batchSize: env.OUTBOX_BATCH_SIZE ? parseInt(env.OUTBOX_BATCH_SIZE) : undefined,
              processingIntervalMs: env.OUTBOX_PROCESSING_INTERVAL_MS ? parseInt(env.OUTBOX_PROCESSING_INTERVAL_MS) : undefined,
              processingTimeoutMs: env.OUTBOX_PROCESSING_TIMEOUT_MS ? parseInt(env.OUTBOX_PROCESSING_TIMEOUT_MS) : undefined,
              enableDeadLetterQueue: env.OUTBOX_ENABLE_DLQ !== 'false',
              circuitBreakerTimeoutMs: env.OUTBOX_CB_TIMEOUT_MS ? parseInt(env.OUTBOX_CB_TIMEOUT_MS) : undefined,
              circuitBreakerSuccessThreshold: env.OUTBOX_CB_SUCCESS_THRESHOLD ? parseInt(env.OUTBOX_CB_SUCCESS_THRESHOLD) : undefined,
              circuitBreakerFailureThreshold: env.OUTBOX_CB_FAILURE_THRESHOLD ? parseInt(env.OUTBOX_CB_FAILURE_THRESHOLD) : undefined,
              eventStoreConfig: {
                   schema: env.EVENT_STORE_SCHEMA,
                   eventsTable: env.EVENT_STORE_EVENTS_TABLE,
              }
          },
          openmemory: {
              url: env.OPENMEMORY_URL,
              apiKey: env.OPENMEMORY_API_KEY || env.OM_API_KEY,
           },
      },
      EVENT_STORE_CUTOVER_MODE: env.EVENT_STORE_CUTOVER_MODE,
      EVENT_STORE_WRITE_PRIMARY_MODE: env.EVENT_STORE_WRITE_PRIMARY_MODE,
      EVENT_STORE_LOGS: env.EVENT_STORE_LOGS,
      EVENT_PERSISTENCE_MODE: env.EVENT_PERSISTENCE_MODE,
      EVENT_STORE_PARTITIONING_POC_ENABLED: env.EVENT_STORE_PARTITIONING_POC_ENABLED,
      EVENT_STORE_PARTITIONING_POC_EVENTS_TABLE: env.EVENT_STORE_PARTITIONING_POC_EVENTS_TABLE,

    // Metrics
    METRICS_ENABLED: env.METRICS_ENABLED,
    METRICS_AUTH_TOKEN: env.METRICS_AUTH_TOKEN,
    METRICS_PORT: env.METRICS_PORT,
    APP_ENABLE_METRICS: env.APP_ENABLE_METRICS,
    APP_METRICS_ROUTE_ENABLED: env.APP_METRICS_ROUTE_ENABLED,
    METRICS_HTTP_BUCKETS: env.METRICS_HTTP_BUCKETS,
    METRICS_DEFAULT_BUCKETS: env.METRICS_DEFAULT_BUCKETS,
    METRICS_EVENT_LATENCY_MS_BUCKETS: env.METRICS_EVENT_LATENCY_MS_BUCKETS,
    METRICS_PREFIX: env.METRICS_PREFIX,
    METRICS_DEBUG: env.METRICS_DEBUG,
    SERVICE_NAME: env.SERVICE_NAME,
      
      // OpenAI / Mock AI
      USE_MOCK_AI: env.USE_MOCK_AI,
      SELF_LLM_URL: env.SELF_LLM_URL,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      OPENAI_ORG_ID: env.OPENAI_ORG_ID,
      OPENAI_BASE_URL: env.OPENAI_BASE_URL,
      OPENAI_TIMEOUT_MS: env.OPENAI_TIMEOUT_MS,
      OPENAI_MAX_RETRIES: env.OPENAI_MAX_RETRIES,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,

      // Per-flag metrics cardinality control
      FF_PER_FLAG_METRICS_ENABLED: env.FF_PER_FLAG_METRICS_ENABLED,
      FF_PER_FLAG_METRICS_ALLOWLIST: env.FF_PER_FLAG_METRICS_ALLOWLIST,

      // Auth / BFF API keys
      JWT_SECRET: env.JWT_SECRET,
      BFF_API_KEYS: env.BFF_API_KEYS,
      BFF_API_KEYS_CSV: env.BFF_API_KEYS_CSV,
      BFF_API_KEY: env.BFF_API_KEY,
      BFF_DEFAULT_USER_ID: env.BFF_DEFAULT_USER_ID,
      BFF_DEFAULT_TENANT_ID: env.BFF_DEFAULT_TENANT_ID,
      HYBRID_RETRIEVAL_ENABLED: env.HYBRID_RETRIEVAL_ENABLED,
      OPENMEMORY_URL: env.OPENMEMORY_URL,
      OPENMEMORY_API_KEY: env.OPENMEMORY_API_KEY,
      OM_API_KEY: env.OM_API_KEY,
      OPENMEMORY_VECTOR_URL: env.OPENMEMORY_VECTOR_URL,
      OPENMEMORY_VECTOR_API_KEY: env.OPENMEMORY_VECTOR_API_KEY,
      OPENMEMORY_VECTOR_TIMEOUT_MS: env.OPENMEMORY_VECTOR_TIMEOUT_MS,
      OPENMEMORY_HSG_URL: env.OPENMEMORY_HSG_URL,
      OPENMEMORY_HSG_API_KEY: env.OPENMEMORY_HSG_API_KEY,
      OPENMEMORY_HSG_TIMEOUT_MS: env.OPENMEMORY_HSG_TIMEOUT_MS,

        // Webhook signing
        SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
  };

  const result = ConfigSchema.safeParse(inputObj);

  if (!result.success) {
    throw result.error;
  }

  return result.data;
}

let cachedConfig: AppConfig | undefined;

/**
 * Validated configuration.
 *
 * One parse of process.env through the schema costs about 200 µs, and readStr /
 * readInt / readBool call this on hot paths. The result is cached until
 * reloadConfig(). Under NODE_ENV=test every call parses again, so a test that
 * edits process.env between bootstrap() calls still sees its values.
 */
export function getConfig(): AppConfig {
  if (process.env.NODE_ENV === 'test') {
    return loadConfigFromEnv(process.env);
  }
  cachedConfig ??= loadConfigFromEnv(process.env);
  return cachedConfig;
}

/**
 * Низкоуровневый доступ к "сырым" переменным окружения.
 *
 * Допустимые сценарии:
 * - редкие случаи чтения динамических ключей (например, FF_<FLAG>_ROLLOUT),
 *   которые не могут быть описаны в типизированной схеме.
 * - только в крайних случаях и только из core/infrastructure-слоя.
 */
export function getRawEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/** Drop the cached configuration. The next getConfig() parses process.env again. */
export function reloadConfig(): void {
  cachedConfig = undefined;
}