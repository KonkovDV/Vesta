import { z } from 'zod';

export const TimePhysicsSchema = z.object({
  tickRateMs: z.number().int().min(100).max(10000).default(1000),
  humanDelayMode: z.enum(['natural', 'instant']).default('natural'),
  maxExecutionTimeMs: z.number().int().positive().max(300000).default(60000),
  sleepJitterMs: z.number().int().min(0).max(5000).default(500),
  allowSteering: z.boolean().default(true),
  maxBankruptcyResets: z.number().int().min(0).max(3).default(1),
});

export const MemoryPhysicsSchema = z.object({
  maxContextTokens: z.number().int().max(200000).default(128000),
  compactionThreshold: z.number().min(0.5).max(0.95).default(0.8),
  contextWarningThreshold: z.number().min(0.5).max(0.95).default(0.8),
  vectorStorePath: z.string().default('./brain/vectors'),
  autoCommitIntervalMs: z.number().int().default(5000),
});

export const CircuitBreakerSchema = z.object({
  failureThreshold: z.number().int().min(1).max(10).default(5),
  resetTimeoutMs: z.number().int().min(1000).max(60000).default(30000),
  halfOpenMaxCalls: z.number().int().min(1).max(10).default(3),
  backoffMultiplier: z.number().min(1).max(10).default(2),
  maxBackoffMs: z.number().int().min(1000).max(300000).default(60000),
});

export const PhysicsSchema = z.object({
  time: TimePhysicsSchema.prefault({}),
  memory: MemoryPhysicsSchema.prefault({}),
  circuitBreaker: CircuitBreakerSchema.prefault({}),
});

export type PhysicsConfig = z.infer<typeof PhysicsSchema>;
