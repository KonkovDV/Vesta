import { z } from 'zod';

export const RedisConnectionSchema = z.object({
  host: z.string().default('localhost'),
  port: z.coerce.number().default(6379),
  password: z.string().optional(),
  db: z.coerce.number().default(0),
  retryDelayOnFailover: z.number().default(100),
  enableOfflineQueue: z.boolean().default(true),
  lazyConnect: z.boolean().default(true),
  maxRetriesPerRequest: z.number().default(3),
  tls: z.object({
    rejectUnauthorized: z.boolean().default(true),
    ca: z.string().optional(),
    cert: z.string().optional(),
    key: z.string().optional(),
  }).optional(),
});

export const RedisEventBusSchema = z.object({
    connection: RedisConnectionSchema.prefault({}),
    keyPrefix: z.string().default('microphoenix:eventbus:'),
    batchSize: z.number().default(100),
    batchInterval: z.number().default(100),
    defaultTimeoutMs: z.number().default(5000),
    defaultMaxRetries: z.number().default(3),
    retryDelayMs: z.number().default(1000),
    enableDeadLetterQueue: z.boolean().default(true),
    deadLetterQueueMaxSize: z.number().default(1000),
    enableMetrics: z.boolean().default(true),
    metricsInterval: z.number().default(60000),
});

export const DatabaseSslSchema = z.object({
  rejectUnauthorized: z.boolean().default(true),
  ca: z.string().optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
});

export const DatabaseSchema = z.object({
  connectionString: z.string().url(),
  ssl: z.union([z.boolean(), DatabaseSslSchema]).default(false),
  max: z.number().default(20),
  idleTimeoutMillis: z.number().default(30000),
  connectionTimeoutMillis: z.number().default(2000),
  keepAlive: z.boolean().default(true),
  keepAliveInitialDelayMillis: z.number().default(10000),
  enableQueryLogging: z.boolean().default(false),
  enableMetrics: z.boolean().default(true),
  statementTimeoutMs: z.number().default(30000),
});

export const OutboxSchema = z.object({
    connection: z.object({
        host: z.string().default('localhost'),
        port: z.coerce.number().default(5432),
        user: z.string().default('postgres'),
        password: z.string().default(''),
        database: z.string().default('microphoenix'),
        ssl: z.object({ rejectUnauthorized: z.boolean() }).optional(),
    }).prefault({}),
    schema: z.string().default('outbox'),
    outboxTable: z.string().default('messages'),
    dlqTable: z.string().default('dead_letter_queue'),
    poolSize: z.number().default(5),
    maxRetries: z.number().default(3),
    retryDelayMs: z.number().default(1000),
    batchSize: z.number().default(10),
    processingIntervalMs: z.number().default(1000),
    processingTimeoutMs: z.number().default(30000),
    enableDeadLetterQueue: z.boolean().default(true),
    circuitBreakerTimeoutMs: z.number().default(30000),
    circuitBreakerSuccessThreshold: z.number().default(3),
    circuitBreakerFailureThreshold: z.number().default(5),
    eventStoreConfig: z.object({
        schema: z.string().default('event_store'),
        eventsTable: z.string().default('events'),
    }).prefault({}),
});

export const OpenMemorySchema = z.object({
  enabled: z.boolean().default(true),
  url: z.string().url().default('http://localhost:3000'),
  apiKey: z.string().optional(),
});

export const InfraSchema = z.object({
    redis: RedisEventBusSchema.prefault({}),
    database: DatabaseSchema, // No default, connectionString required
    outbox: OutboxSchema.prefault({}),
    openmemory: OpenMemorySchema.prefault({}),
});

export type InfraConfig = z.infer<typeof InfraSchema>;
