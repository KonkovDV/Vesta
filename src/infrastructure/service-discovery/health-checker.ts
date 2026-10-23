/**
 * Service Health Checker
 * Implements active and passive health checking for service instances.
 * Layer: Infrastructure
 *
 * Features:
 * - Active health checks via HTTP/TCP
 * - Passive health checks from heartbeats
 * - Circuit breaker integration
 * - Health status transitions with hysteresis
 */

import { EventEmitter } from 'events';
import { HealthStatus, ServiceInstance } from '../../domain/service-discovery';
import { ICircuitBreaker } from '../../domain/external/ICircuitBreaker';

/**
 * Health check configuration
 */
export interface HealthCheckConfig {
  intervalMs: number;
  timeoutMs: number;
  healthyThreshold: number;
  unhealthyThreshold: number;
  passiveTimeoutMs: number;
}

/**
 * Active health check result
 */
export interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Health check strategy type
 */
export type HealthCheckStrategy = 'HTTP' | 'TCP' | 'PASSIVE' | 'CUSTOM';

/**
 * HTTP health check options
 */
export interface HttpHealthCheckOptions {
  path: string;
  method?: string;
  expectedStatus?: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Health checker options for a service
 */
export interface ServiceHealthOptions {
  strategy: HealthCheckStrategy;
  httpOptions?: HttpHealthCheckOptions;
  customChecker?: () => Promise<HealthCheckResult>;
}

/**
 * Service health state
 */
interface ServiceHealthState {
  instance: ServiceInstance;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastCheckTime: number;
  lastHeartbeatTime: number;
  checkTimer: NodeJS.Timeout | null;
  options: ServiceHealthOptions;
}

/**
 * Health status change event
 */
export interface HealthStatusChangeEvent {
  serviceId: string;
  previousStatus: HealthStatus;
  newStatus: HealthStatus;
  reason: string;
  timestamp: Date;
}

/**
 * Service health checker implementation
 */
export class ServiceHealthChecker extends EventEmitter {
  private services = new Map<string, ServiceHealthState>();
  private running = false;
  private defaultConfig: HealthCheckConfig;

  constructor(
    config: Partial<HealthCheckConfig> = {},
    private circuitBreaker?: ICircuitBreaker
  ) {
    super();

    this.defaultConfig = {
      intervalMs: 10000,
      timeoutMs: 5000,
      healthyThreshold: 2,
      unhealthyThreshold: 3,
      passiveTimeoutMs: 30000,
      ...config,
    };
  }

  /**
   * Start the health checker
   */
  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.emit('started');
  }

  /**
   * Stop the health checker
   */
  async stop(): Promise<void> {
    this.running = false;

    // Clear all check timers
    for (const state of this.services.values()) {
      if (state.checkTimer) {
        clearInterval(state.checkTimer);
        state.checkTimer = null;
      }
    }

    this.emit('stopped');
  }

  /**
   * Register a service for health checking
   */
  registerService(
    instance: ServiceInstance,
    options: Partial<ServiceHealthOptions> = {}
  ): void {
    const serviceId = instance.id;

    // Unregister if already exists
    if (this.services.has(serviceId)) {
      this.unregisterService(serviceId);
    }

    const state: ServiceHealthState = {
      instance,
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      lastCheckTime: 0,
      lastHeartbeatTime: Date.now(),
      checkTimer: null,
      options: this.buildOptions(instance, options),
    };

    this.services.set(serviceId, state);

    // Start health checks if using active strategy
    if (this.running) {
       if (state.options.strategy !== 'PASSIVE') {
         this.startHealthChecks(serviceId, state);
       } else {
         // Treat registration as initial heartbeat for PASSIVE services
         this.heartbeat(serviceId);
       }
    }

    this.emit('serviceRegistered', { serviceId, instance });
  }

  /**
   * Unregister a service from health checking
   */
  unregisterService(serviceId: string): void {
    const state = this.services.get(serviceId);
    if (!state) return;

    if (state.checkTimer) {
      clearInterval(state.checkTimer);
    }

    this.services.delete(serviceId);
    this.emit('serviceUnregistered', { serviceId });
  }

  /**
   * Record a heartbeat from a service (passive health check)
   */
  heartbeat(serviceId: string): void {
    const state = this.services.get(serviceId);
    if (!state) return;

    state.lastHeartbeatTime = Date.now();

    // If service was unhealthy due to missing heartbeats, check if it should recover
    if (state.instance.health === 'UNHEALTHY' || state.instance.health === 'UNKNOWN' || state.instance.health === 'STARTING') {
      this.checkPassiveHealth(serviceId, state);
    }

    this.emit('heartbeatReceived', { serviceId, timestamp: new Date() });
  }

  /**
   * Update service instance
   */
  updateInstance(instance: ServiceInstance): void {
    const state = this.services.get(instance.id);
    if (!state) return;

    state.instance = instance;
  }

  /**
   * Get health status for a service
   */
  getHealthStatus(serviceId: string): HealthStatus | null {
    const state = this.services.get(serviceId);
    return state?.instance.health ?? null;
  }

  /**
   * Get all healthy services
   */
  getHealthyServices(): ServiceInstance[] {
    return Array.from(this.services.values())
      .filter((state) => state.instance.health === 'HEALTHY')
      .map((state) => state.instance);
  }

  /**
   * Get all unhealthy services
   */
  getUnhealthyServices(): ServiceInstance[] {
    return Array.from(this.services.values())
      .filter((state) => state.instance.health !== 'HEALTHY')
      .map((state) => state.instance);
  }

  /**
   * Perform immediate health check on a service
   */
  async checkHealth(serviceId: string): Promise<HealthCheckResult> {
    const state = this.services.get(serviceId);
    if (!state) {
      return { healthy: false, latencyMs: 0, error: 'Service not found' };
    }

    return this.performActiveCheck(state);
  }

  /**
   * Build health check options with defaults
   */
  private buildOptions(
    instance: ServiceInstance,
    options: Partial<ServiceHealthOptions>
  ): ServiceHealthOptions {
    const strategy = options.strategy || this.inferStrategy(instance);

    return {
      strategy,
      httpOptions: options.httpOptions || {
        path: instance.metadata.healthCheckPath || '/health',
        method: 'GET',
        expectedStatus: 200,
      },
      customChecker: options.customChecker,
    };
  }

  /**
   * Infer health check strategy from service metadata
   */
  private inferStrategy(instance: ServiceInstance): HealthCheckStrategy {
    if (instance.metadata.healthCheckStrategy) {
      return instance.metadata.healthCheckStrategy as HealthCheckStrategy;
    }

    // Default to HTTP if port suggests HTTP service
    if (instance.port === 80 || instance.port === 443 || instance.port === 8080) {
      return 'HTTP';
    }

    return 'PASSIVE';
  }

  /**
   * Start periodic health checks for a service
   */
  private startHealthChecks(serviceId: string, state: ServiceHealthState): void {
    if (state.checkTimer) return;

    // Perform initial check
    void this.performHealthCheck(serviceId, state);

    // Set up periodic checks
    state.checkTimer = setInterval(() => {
      if (this.running) {
        void this.performHealthCheck(serviceId, state);
      }
    }, this.defaultConfig.intervalMs);
  }

  /**
   * Perform health check and update status
   */
  private async performHealthCheck(
    serviceId: string,
    state: ServiceHealthState
  ): Promise<void> {
    // Use circuit breaker if available
    if (this.circuitBreaker && this.circuitBreaker.getState() === 'OPEN') {
      this.emit('healthCheckSkipped', { serviceId, reason: 'Circuit breaker open' });
      return;
    }

    let result: HealthCheckResult;

    try {
      result = await this.performActiveCheck(state);
    } catch (error) {
      result = {
        healthy: false,
        latencyMs: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    state.lastCheckTime = Date.now();

    // Update health status based on result
    this.updateHealthStatus(serviceId, state, result);
  }

  /**
   * Perform active health check
   */
  private async performActiveCheck(state: ServiceHealthState): Promise<HealthCheckResult> {
    const startTime = Date.now();

    switch (state.options.strategy) {
      case 'HTTP':
        return this.performHttpCheck(state, startTime);

      case 'TCP':
        return this.performTcpCheck(state, startTime);

      case 'CUSTOM':
        if (state.options.customChecker) {
          return state.options.customChecker();
        }
        return { healthy: false, latencyMs: 0, error: 'No custom checker provided' };

      case 'PASSIVE':
      default:
        return { healthy: true, latencyMs: 0 };
    }
  }

  /**
   * Perform HTTP health check
   */
  private async performHttpCheck(
    state: ServiceHealthState,
    startTime: number
  ): Promise<HealthCheckResult> {
    const options = state.options.httpOptions!;
    const { host, port } = state.instance;
    const protocol = port === 443 ? 'https' : 'http';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultConfig.timeoutMs);

    try {
      const response = await fetch(`${protocol}://${host}:${port}${options.path}`, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const latencyMs = Date.now() - startTime;
      const expectedStatus = options.expectedStatus || 200;

      if (response.status === expectedStatus) {
        return { healthy: true, latencyMs };
      } else {
        return {
          healthy: false,
          latencyMs,
          error: `Unexpected status: ${response.status}`,
        };
      }
    } catch (error) {
      clearTimeout(timeout);
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'HTTP check failed',
      };
    }
  }

  /**
   * Perform TCP health check
   */
  private async performTcpCheck(
    state: ServiceHealthState,
    startTime: number
  ): Promise<HealthCheckResult> {
    const net = await import('net');

    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({
          healthy: false,
          latencyMs: Date.now() - startTime,
          error: 'TCP connection timeout',
        });
      }, this.defaultConfig.timeoutMs);

      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ healthy: true, latencyMs: Date.now() - startTime });
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({
          healthy: false,
          latencyMs: Date.now() - startTime,
          error: error.message,
        });
      });

      socket.connect(state.instance.port, state.instance.host);
    });
  }

  /**
   * Update health status based on check result
   */
  private updateHealthStatus(
    serviceId: string,
    state: ServiceHealthState,
    result: HealthCheckResult
  ): void {
    const previousStatus = state.instance.health;
    let newStatus = previousStatus;

    if (result.healthy) {
      state.consecutiveSuccesses++;
      state.consecutiveFailures = 0;

      if (
        previousStatus !== 'HEALTHY' &&
        state.consecutiveSuccesses >= this.defaultConfig.healthyThreshold
      ) {
        newStatus = 'HEALTHY';
      }
    } else {
      state.consecutiveFailures++;
      state.consecutiveSuccesses = 0;

      if (
        previousStatus === 'HEALTHY' &&
        state.consecutiveFailures >= this.defaultConfig.unhealthyThreshold
      ) {
        newStatus = 'UNHEALTHY';
      } else if (
        previousStatus === 'UNKNOWN' &&
        state.consecutiveFailures >= this.defaultConfig.unhealthyThreshold
      ) {
        newStatus = 'UNHEALTHY';
      }
    }

    if (newStatus !== previousStatus) {
      state.instance.health = newStatus;

      const event: HealthStatusChangeEvent = {
        serviceId,
        previousStatus,
        newStatus,
        reason: result.error || 'Health check status changed',
        timestamp: new Date(),
      };

      this.emit('healthStatusChanged', event);
    }

    this.emit('healthCheckCompleted', {
      serviceId,
      result,
      status: newStatus,
    });
  }

  /**
   * Check passive health (heartbeat-based)
   */
  private checkPassiveHealth(serviceId: string, state: ServiceHealthState): void {
    const timeSinceLastHeartbeat = Date.now() - state.lastHeartbeatTime;

    if (timeSinceLastHeartbeat > this.defaultConfig.passiveTimeoutMs) {
      const previousStatus = state.instance.health;

      if (previousStatus !== 'UNHEALTHY') {
        state.instance.health = 'UNHEALTHY';

        const event: HealthStatusChangeEvent = {
          serviceId,
          previousStatus,
          newStatus: 'UNHEALTHY',
          reason: `No heartbeat for ${timeSinceLastHeartbeat}ms`,
          timestamp: new Date(),
        };

        this.emit('healthStatusChanged', event);
      }
    } else if (state.instance.health === 'UNHEALTHY' || state.instance.health === 'STARTING' || state.instance.health === 'UNKNOWN') {
      // Recovery detected
      const previousStatus = state.instance.health;
      state.instance.health = 'HEALTHY';

      const event: HealthStatusChangeEvent = {
        serviceId,
        previousStatus,
        newStatus: 'HEALTHY',
        reason: 'Heartbeat received - service recovered',
        timestamp: new Date(),
      };

      this.emit('healthStatusChanged', event);
    }
  }
}
