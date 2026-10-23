/**
 * Sandbox Pool Manager
 * Manages pool of pre-warmed sandboxes for efficient code execution.
 * Implements resource limits, health checks, and cleanup.
 * Layer: Infrastructure
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
  ISandboxedExecutor,
  SandboxExecutionOptions,
  SandboxExecutionResult,
} from '../../domain/sandbox/sandboxed-executor.port';

export interface SandboxPoolConfig {
  minPoolSize: number;
  maxPoolSize: number;
  maxConcurrentExecutions: number;
  warmupIntervalMs: number;
  idleTimeoutMs: number;
  healthCheckIntervalMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface PooledSandbox {
  id: string;
  executor: ISandboxedExecutor;
  inUse: boolean;
  lastUsedAt: Date;
  createdAt: Date;
  useCount: number;
  healthy: boolean;
}

export interface PoolMetrics {
  totalSandboxes: number;
  availableSandboxes: number;
  inUseSandboxes: number;
  queuedRequests: number;
  totalExecutions: number;
  failedExecutions: number;
  averageExecutionTimeMs: number;
}

export class SandboxPool extends EventEmitter {
  private config: SandboxPoolConfig;
  private pool: Map<string, PooledSandbox> = new Map();
  private queue: Array<{
    options: SandboxExecutionOptions;
    resolve: (result: SandboxExecutionResult) => void;
    reject: (error: Error) => void;
    enqueueTime: number;
    retries: number;
  }> = [];
  private executorFactory: () => ISandboxedExecutor;
  private metrics = {
    totalExecutions: 0,
    failedExecutions: 0,
    totalExecutionTimeMs: 0,
  };
  private warmupInterval?: NodeJS.Timeout;
  private healthCheckInterval?: NodeJS.Timeout;
  private idleCleanupInterval?: NodeJS.Timeout;
  private isShuttingDown = false;

  constructor(
    executorFactory: () => ISandboxedExecutor,
    config?: Partial<SandboxPoolConfig>,
  ) {
    super();
    this.executorFactory = executorFactory;
    this.config = {
      minPoolSize: 2,
      maxPoolSize: 10,
      maxConcurrentExecutions: 5,
      warmupIntervalMs: 60000,
      idleTimeoutMs: 300000,
      healthCheckIntervalMs: 30000,
      maxRetries: 3,
      retryDelayMs: 1000,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    this.emit('pool:initializing');
    
    // Create minimum pool size
    for (let i = 0; i < this.config.minPoolSize; i++) {
      await this.createSandbox();
    }

    // Start background tasks
    this.startWarmupInterval();
    this.startHealthCheckInterval();
    this.startIdleCleanupInterval();

    this.emit('pool:initialized', { poolSize: this.pool.size });
  }

  async execute(options: SandboxExecutionOptions): Promise<SandboxExecutionResult> {
    if (this.isShuttingDown) {
      throw new Error('Sandbox pool is shutting down');
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        options,
        resolve,
        reject,
        enqueueTime: Date.now(),
        retries: 0,
      });
      void this.processQueue();
    });
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.emit('pool:shutting-down');

    // Clear intervals
    if (this.warmupInterval) clearInterval(this.warmupInterval);
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.idleCleanupInterval) clearInterval(this.idleCleanupInterval);

    // Reject queued requests
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      if (request) {
        request.reject(new Error('Sandbox pool is shutting down'));
      }
    }

    // Cleanup all sandboxes
    const cleanupPromises: Promise<void>[] = [];
    for (const sandbox of this.pool.values()) {
      cleanupPromises.push(this.destroySandbox(sandbox));
    }
    await Promise.allSettled(cleanupPromises);

    this.pool.clear();
    this.emit('pool:shutdown');
  }

  getMetrics(): PoolMetrics {
    const sandboxes = Array.from(this.pool.values());
    const inUse = sandboxes.filter(s => s.inUse).length;
    
    return {
      totalSandboxes: this.pool.size,
      availableSandboxes: this.pool.size - inUse,
      inUseSandboxes: inUse,
      queuedRequests: this.queue.length,
      totalExecutions: this.metrics.totalExecutions,
      failedExecutions: this.metrics.failedExecutions,
      averageExecutionTimeMs: this.metrics.totalExecutions > 0
        ? Math.round(this.metrics.totalExecutionTimeMs / this.metrics.totalExecutions)
        : 0,
    };
  }

  private async createSandbox(): Promise<PooledSandbox> {
    const id = randomUUID();
    const executor = this.executorFactory();

    const sandbox: PooledSandbox = {
      id,
      executor,
      inUse: false,
      lastUsedAt: new Date(),
      createdAt: new Date(),
      useCount: 0,
      healthy: true,
    };

    // Verify executor is available
    try {
      const available = await executor.isAvailable();
      if (!available) {
        throw new Error('Executor is not available');
      }
    } catch (error) {
      this.emit('sandbox:creation-failed', { id, error });
      throw error;
    }

    this.pool.set(id, sandbox);
    this.emit('sandbox:created', { id });
    
    return sandbox;
  }

  private async destroySandbox(sandbox: PooledSandbox): Promise<void> {
    sandbox.healthy = false;
    this.pool.delete(sandbox.id);
    
    // If the executor has a killAll method, call it
    if ('killAll' in sandbox.executor && typeof sandbox.executor.killAll === 'function') {
      try {
        await (sandbox.executor as unknown as { killAll(): Promise<void> }).killAll();
      } catch (error) {
        this.emit('sandbox:cleanup-error', { id: sandbox.id, error });
      }
    }
    
    this.emit('sandbox:destroyed', { id: sandbox.id });
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) return;

    const availableSandbox = this.findAvailableSandbox();
    if (!availableSandbox) {
      // Try to expand pool if under max size
      if (this.pool.size < this.config.maxPoolSize) {
        try {
          await this.createSandbox();
          void this.processQueue();
        } catch (error) {
          this.emit('pool:expansion-failed', { error });
        }
      }
      return;
    }

    const request = this.queue.shift();
    if (!request) return;

    // Check if request has been waiting too long
    const waitTime = Date.now() - request.enqueueTime;
    const maxWaitTime = request.options.timeoutMs;
    if (waitTime > maxWaitTime) {
      request.reject(new Error('Request timed out while waiting in queue'));
      void this.processQueue();
      return;
    }

    await this.executeWithSandbox(availableSandbox, request);
  }

  private findAvailableSandbox(): PooledSandbox | undefined {
    for (const sandbox of this.pool.values()) {
      if (!sandbox.inUse && sandbox.healthy) {
        return sandbox;
      }
    }
    return undefined;
  }

  private async executeWithSandbox(
    sandbox: PooledSandbox,
    request: {
      options: SandboxExecutionOptions;
      resolve: (result: SandboxExecutionResult) => void;
      reject: (error: Error) => void;
      retries: number;
    },
  ): Promise<void> {
    sandbox.inUse = true;
    this.emit('sandbox:acquired', { id: sandbox.id });

    try {
      const result = await sandbox.executor.execute(request.options);
      
      sandbox.useCount++;
      sandbox.lastUsedAt = new Date();
      sandbox.inUse = false;
      
      this.metrics.totalExecutions++;
      this.metrics.totalExecutionTimeMs += result.durationMs;
      
      this.emit('sandbox:released', { id: sandbox.id, success: true });
      request.resolve(result);
    } catch (error) {
      sandbox.inUse = false;
      
      if (request.retries < this.config.maxRetries) {
        request.retries++;
        await this.delay(this.config.retryDelayMs * request.retries);
        this.queue.unshift({
          ...request,
          enqueueTime: Date.now(),
        });
        this.emit('sandbox:retry', { id: sandbox.id, attempt: request.retries });
      } else {
        this.metrics.failedExecutions++;
        sandbox.healthy = false; // Mark as unhealthy after max retries
        this.emit('sandbox:released', { id: sandbox.id, success: false });
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    void this.processQueue();
  }

  private startWarmupInterval(): void {
    this.warmupInterval = setInterval(async () => {
      if (this.isShuttingDown) return;
      
      const healthyCount = Array.from(this.pool.values()).filter(s => s.healthy && !s.inUse).length;
      if (healthyCount < this.config.minPoolSize && this.pool.size < this.config.maxPoolSize) {
        try {
          await this.createSandbox();
        } catch (error) {
          this.emit('pool:warmup-failed', { error });
        }
      }
    }, this.config.warmupIntervalMs);
  }

  private startHealthCheckInterval(): void {
    this.healthCheckInterval = setInterval(async () => {
      if (this.isShuttingDown) return;

      for (const sandbox of this.pool.values()) {
        if (sandbox.inUse) continue;

        try {
          const available = await sandbox.executor.isAvailable();
          if (!available && sandbox.healthy) {
            sandbox.healthy = false;
            this.emit('sandbox:unhealthy', { id: sandbox.id });
          } else if (available && !sandbox.healthy) {
            sandbox.healthy = true;
            this.emit('sandbox:healthy', { id: sandbox.id });
          }
        } catch (error) {
          sandbox.healthy = false;
          this.emit('sandbox:health-check-failed', { id: sandbox.id, error });
        }
      }
    }, this.config.healthCheckIntervalMs);
  }

  private startIdleCleanupInterval(): void {
    this.idleCleanupInterval = setInterval(async () => {
      if (this.isShuttingDown) return;

      const now = Date.now();
      const toCleanup: PooledSandbox[] = [];

      for (const sandbox of this.pool.values()) {
        if (sandbox.inUse) continue;
        if (sandbox.healthy && this.pool.size <= this.config.minPoolSize) continue;
        
        const idleTime = now - sandbox.lastUsedAt.getTime();
        if (idleTime > this.config.idleTimeoutMs) {
          toCleanup.push(sandbox);
        }
      }

      // Keep minimum pool size
      const healthyCount = Array.from(this.pool.values()).filter(s => s.healthy && !s.inUse).length;
      const canCleanup = Math.max(0, healthyCount - this.config.minPoolSize);
      
      for (let i = 0; i < Math.min(toCleanup.length, canCleanup); i++) {
        await this.destroySandbox(toCleanup[i]);
      }
    }, this.config.idleTimeoutMs);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
