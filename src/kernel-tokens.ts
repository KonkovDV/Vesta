/**
 * Typed tokens for the kernel ports a project may resolve (T2.3, step 1).
 * `container.inject(KernelTokens.IEventStore)` returns an IEventStore without a
 * type argument; `container.provide(token, factory)` checks what the factory returns.
 * Each value is the string the kernel registers that port under.
 */
import { createToken } from './core/di/injection-token';
import { DI_TOKENS } from './core/di/DI_TOKENS';
import type { ILogger } from './core/decorators/ILogger';
import type { IEventStore } from './domain/events/event-store.interface';
import type { IOutbox } from './domain/events/outbox.interface';
import type { IEventBus } from './domain/events/event-bus.interface';
import type { IToolExecutionPolicy } from './domain/security/tool-execution-policy.interface';
import type { ICronService } from './domain/scheduling/cron-service.port';
import type { IDatabaseConnection } from './domain/persistence/IDatabaseConnection';

export const KernelTokens = {
  IEventStore: createToken<IEventStore>(DI_TOKENS.IEventStore),
  IOutbox: createToken<IOutbox>(DI_TOKENS.IOutbox),
  IEventBus: createToken<IEventBus>(DI_TOKENS.IEventBus),
  IToolExecutionPolicy: createToken<IToolExecutionPolicy>(DI_TOKENS.IToolExecutionPolicy),
  ICronService: createToken<ICronService>(DI_TOKENS.ICronService),
  IDatabaseConnection: createToken<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection),
  ILogger: createToken<ILogger>(DI_TOKENS.ILogger),
} as const;
