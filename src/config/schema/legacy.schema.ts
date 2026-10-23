import { z } from 'zod';

export const LegacyConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development').optional(),
    PORT: z.coerce.number().int().min(0).max(65535).optional(),

    // HTTP / app
    ENABLE_HTTP: z.string().optional(),
    HTTP_LOG_START: z.string().optional(),
    ALLOWED_ORIGINS: z.string().optional(),
    ALLOWED_METHODS: z.string().optional(),
    ALLOWED_HEADERS: z.string().optional(),

    // Infra bootstrap
    INFRA_INIT_TIMEOUT_MS: z.string().optional(),
    INFRA_LOG_INIT: z.string().optional(),
    APP_LOG_INIT: z.string().optional(),
    APP_BOOTSTRAP_FORCE: z.string().optional(),

    // Circuit Breakers backend
    CB_BACKEND: z.enum(['memory', 'postgres']).optional(),
    CB_POLICY_PROVIDER: z.string().optional(),

    // Database
    DATABASE_URL: z.string().optional(),
    DB_HOST: z.string().min(1).optional(),
    DB_PORT: z.string().optional(),
    DB_USER: z.string().min(1).optional(),
    DB_PASSWORD: z.string().min(1).optional(),
    DB_NAME: z.string().min(1).optional(),
    DB_MAX_CONNECTIONS: z.string().optional(),
    DB_IDLE_TIMEOUT_MS: z.string().optional(),
    DB_CONNECTION_TIMEOUT_MS: z.string().optional(),
    DB_ENABLE_QUERY_LOGGING: z.string().optional(),
    DB_ENABLE_METRICS: z.string().optional(),
    DB_SSL: z.string().optional(),
    DB_SSL_CA: z.string().optional(),
    DB_SSL_CERT: z.string().optional(),
    DB_SSL_KEY: z.string().optional(),
    DB_SSL_REJECT_UNAUTHORIZED: z.string().optional(),

    // Event store
    EVENT_STORE_HOST: z.string().optional(),
    EVENT_STORE_PORT: z.string().optional(),
    EVENT_STORE_USER: z.string().optional(),
    EVENT_STORE_PASSWORD: z.string().optional(),
    EVENT_STORE_DATABASE: z.string().optional(),
    EVENT_STORE_SCHEMA: z.string().optional(),
    EVENT_STORE_EVENTS_TABLE: z.string().optional(),
    EVENT_STORE_SNAPSHOTS_TABLE: z.string().optional(),
    EVENT_STORE_LOGS: z.string().optional(),
    EVENT_PERSISTENCE_MODE: z.string().optional(),
    EVENT_STORE_CUTOVER_MODE: z.string().optional(),
    EVENT_STORE_WRITE_PRIMARY_MODE: z.string().optional(),
 
    // Event store partitioning POC (R2.2)
    EVENT_STORE_PARTITIONING_POC_ENABLED: z.string().optional(),
    EVENT_STORE_PARTITIONING_POC_EVENTS_TABLE: z.string().optional(),

    // MAS Redis Streams pilot (R2.3)
    MAS_REDIS_STREAMS_PILOT_ENABLED: z.string().optional(),
    MAS_REDIS_STREAMS_PRODUCER_ENABLED: z.string().optional(),
    MAS_REDIS_STREAMS_PROJECTORS_ENABLED: z.string().optional(),
    MAS_REDIS_STREAMS_MAXLEN: z.string().optional(),
    MAS_REDIS_STREAMS_DEDUP_TTL_SECONDS: z.string().optional(),
    MAS_TASK_STATS_WINDOW_MINUTES: z.string().optional(),

    // Redis (generic + event bus)
    REDIS_HOST: z.string().optional(),
    REDIS_PORT: z.coerce.number().optional(),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_DB: z.coerce.number().optional(),
    REDIS_KEY_PREFIX: z.string().optional(),
    REDIS_CLUSTER: z.string().optional(),
    REDIS_ENABLE_METRICS: z.string().optional(),
    REDIS_RETRY_DELAY: z.string().optional(),
    REDIS_ENABLE_OFFLINE_QUEUE: z.string().optional(),
    REDIS_LAZY_CONNECT: z.string().optional(),
    REDIS_MAX_RETRIES: z.string().optional(),
    REDIS_TLS: z.string().optional(),
    REDIS_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
    REDIS_TLS_CA: z.string().optional(),
    REDIS_TLS_CERT: z.string().optional(),
    REDIS_TLS_KEY: z.string().optional(),

    REDIS_EVENT_BUS_HOST: z.string().optional(),
    REDIS_EVENT_BUS_PORT: z.string().optional(),
    REDIS_EVENT_BUS_PASSWORD: z.string().optional(),
    REDIS_EVENT_BUS_DB: z.string().optional(),
    REDIS_EVENT_BUS_PREFIX: z.string().optional(),
    REDIS_EVENT_BUS_BATCH_SIZE: z.string().optional(),
    REDIS_EVENT_BUS_BATCH_INTERVAL: z.string().optional(),
    REDIS_EVENT_BUS_DEFAULT_TIMEOUT: z.string().optional(),
    REDIS_EVENT_BUS_DEFAULT_RETRIES: z.string().optional(),
    REDIS_EVENT_BUS_RETRY_DELAY: z.string().optional(),
    REDIS_EVENT_BUS_DLQ: z.string().optional(),
    REDIS_EVENT_BUS_DLQ_MAX_SIZE: z.string().optional(),
    REDIS_EVENT_BUS_METRICS: z.string().optional(),
    REDIS_EVENT_BUS_METRICS_INTERVAL: z.string().optional(),
    REDIS_EVENT_BUS_LOGS: z.string().optional(),

    // Outbox
    OUTBOX_HOST: z.string().optional(),
    OUTBOX_PORT: z.string().optional(),
    OUTBOX_USER: z.string().optional(),
    OUTBOX_PASSWORD: z.string().optional(),
    OUTBOX_DATABASE: z.string().optional(),
    OUTBOX_SSL: z.string().optional(),
    OUTBOX_SCHEMA: z.string().optional(),
    OUTBOX_TABLE: z.string().optional(),
    OUTBOX_DLQ_TABLE: z.string().optional(),
    OUTBOX_POOL_SIZE: z.string().optional(),
    OUTBOX_MAX_RETRIES: z.string().optional(),
    OUTBOX_RETRY_DELAY_MS: z.string().optional(),
    OUTBOX_BATCH_SIZE: z.string().optional(),
    OUTBOX_PROCESSING_INTERVAL_MS: z.string().optional(),
    OUTBOX_PROCESSING_TIMEOUT_MS: z.string().optional(),
    OUTBOX_ENABLE_DLQ: z.string().optional(),
    OUTBOX_CB_TIMEOUT_MS: z.string().optional(),
    OUTBOX_CB_SUCCESS_THRESHOLD: z.string().optional(),
    OUTBOX_CB_FAILURE_THRESHOLD: z.string().optional(),
    OUTBOX_AUTO_START: z.string().optional(),
    OUTBOX_LOGS: z.string().optional(),

    // Metrics
    METRICS_ENABLED: z.string().optional(),
    METRICS_AUTH_TOKEN: z.string().optional(),
    METRICS_PORT: z.string().optional(),
    APP_ENABLE_METRICS: z.string().optional(),
    APP_METRICS_ROUTE_ENABLED: z.string().optional(),
    METRICS_HTTP_BUCKETS: z.string().optional(),
    METRICS_DEFAULT_BUCKETS: z.string().optional(),
    METRICS_EVENT_LATENCY_MS_BUCKETS: z.string().optional(),
    METRICS_PREFIX: z.string().optional(),
    METRICS_DEBUG: z.string().optional(),
    SERVICE_NAME: z.string().optional(),

    // Auth / security
    JWT_SECRET: z.string().min(32).optional(),
    BFF_API_KEYS: z.string().optional(),
    BFF_API_KEYS_CSV: z.string().optional(),
    BFF_API_KEY: z.string().optional(),
    BFF_DEFAULT_USER_ID: z.string().optional(),
    BFF_DEFAULT_TENANT_ID: z.string().optional(),
    PLUGINS_ALLOW_CORRELATION_FALLBACK: z.string().optional(),

    // Memory / OpenMemory / MAS session store
    MAS_SESSION_STORE: z.string().optional(),
    
    // Request Context
    REQUEST_CONTEXT_STRICT_ROOT_CREATION: z.string().optional(),

    APP_MEMORY_MODE: z.string().optional(),
    HYBRID_RETRIEVAL_ENABLED: z.string().optional(),
    MEM_NEXT_GRAPH_EXPAND_ENABLED: z.string().optional(),
    MEM_NEXT_GRAPH_EXPAND: z.string().optional(),
    CODE_GRAPH_KUZU_PATH: z.string().optional(),
    OPENMEMORY_URL: z.string().optional(),
    OPENMEMORY_API_KEY: z.string().optional(),
    OM_API_KEY: z.string().optional(),
    OPENMEMORY_VECTOR_URL: z.string().optional(),
    OPENMEMORY_VECTOR_API_KEY: z.string().optional(),
    OPENMEMORY_VECTOR_TIMEOUT_MS: z.string().optional(),
    OPENMEMORY_HSG_URL: z.string().optional(),
    OPENMEMORY_HSG_API_KEY: z.string().optional(),
    OPENMEMORY_HSG_TIMEOUT_MS: z.string().optional(),

    // MAS Runtime policies (MAS-RT-R2)
    // JSON-encoded policy objects consumed by MasRuntimePolicyService.
    MAS_RUNTIME_POLICY_NON_DURABLE: z.string().optional(),
    MAS_RUNTIME_POLICY_DURABLE: z.string().optional(),

    // LLM / providers
    LLM_PROVIDER: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_ORG_ID: z.string().optional(),
    OPENAI_BASE_URL: z.string().optional(),
    OPENAI_DEFAULT_MODEL: z.string().optional(),
    OPENAI_DEFAULT_EMBEDDING_MODEL: z.string().optional(),
    OPENAI_DEFAULT_MODERATION_MODEL: z.string().optional(),
    OPENAI_TIMEOUT_MS: z.string().optional(),
    OPENAI_MAX_RETRIES: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_BASE_URL: z.string().optional(),
    LLM_ENABLE_FAILOVER: z.string().optional(),
    LLM_MAX_FAILOVER_ATTEMPTS: z.string().optional(),

    // Research / LLM rate limiting
    LLM_RESEARCH_RATE_LIMIT_MAX_TOKENS: z.string().optional(),
    LLM_RESEARCH_RATE_LIMIT_REFILL_RATE: z.string().optional(),

    // Python skills
    PYTHON_SKILL_MAX_CONCURRENT_PROCESSES: z.string().optional(),

    // AWS / S3
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_REGION: z.string().optional(),
    AWS_S3_BUCKET: z.string().optional(),
    AWS_S3_BASE_URL: z.string().optional(),
    AWS_S3_KEY_PREFIX: z.string().optional(),
    AWS_S3_SIGNED_URL_EXPIRY: z.string().optional(),
    AWS_S3_MAX_FILE_SIZE: z.string().optional(),
    AWS_S3_ALLOWED_MIME_TYPES: z.string().optional(),

    // Slack
    SLACK_BOT_TOKEN: z.string().optional(),
    SLACK_SIGNING_SECRET: z.string().optional(),
    SLACK_API_BASE: z.string().optional(),
    SLACK_WEBHOOK_URL: z.string().optional(),
    SLACK_DEBUG: z.string().optional(),

    // AOP
    DISABLE_AOP_LOGGING: z.string().optional(),
    ENABLE_AOP_METRICS: z.string().optional(),
    DISABLE_AOP_CACHING: z.string().optional(),
    DISABLE_AOP_RETRY: z.string().optional(),
    DISABLE_AOP_SECURITY: z.string().optional(),
    AOP_RETRY_ATTEMPTS: z.string().optional(),
    AOP_RETRY_DELAY_MS: z.string().optional(),
    AOP_RETRY_MULTIPLIER: z.string().optional(),
    AOP_RETRY_MAX_DELAY_MS: z.string().optional(),
    AOP_CACHE_PREFIX: z.string().optional(),

    // RequestContext / observability
    REQUEST_CONTEXT_MAX_METADATA_SIZE: z.string().optional(),
    REQUEST_CONTEXT_MAX_EVENTS: z.string().optional(),


    // Misc / testing
    APP_VERSION: z.string().optional(),
    BFF_ENV: z.string().optional(),
    EVENT_STORE_MW_DEBUG: z.string().optional(),
    SUBSCRIBER_LOGS: z.string().optional(),
    PLUGIN_SANDBOX_TIMEOUT_MS: z.string().optional(),
    CHAT_LLM_ENABLED: z.string().optional(),
    CHAT_LLM_MODE: z.string().optional(),
    FF_PER_FLAG_METRICS_ENABLED: z.string().optional(),
    FF_PER_FLAG_METRICS_ALLOWLIST: z.string().optional(),
    FF_METRICS_ENABLED: z.string().optional(),
    JEST_WORKER_ID: z.string().optional(),
    USE_MOCK_AI: z.string().optional(),
    SELF_LLM_URL: z.string().optional(),
  })
  .passthrough();
