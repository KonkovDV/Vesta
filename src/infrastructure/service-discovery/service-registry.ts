/**
 * Distributed Service Registry
 * Implements a distributed service registry with Raft consensus.
 * Layer: Infrastructure
 *
 * Features:
 * - In-memory registry with Raft replication
 * - Health checking integration
 * - TTL-based expiration
 * - Watch notifications for service changes
 */

import { EventEmitter } from 'events';
import {
  IServiceDiscovery,
  ServiceRegistration,
  ServiceInstance,
  ServiceDiscoveryError,
  ServiceDiscoveryErrorCode,
  ServiceWatchCallback,
  HealthStatus,
} from '../../domain/service-discovery';
import {
  RaftConsensusService,
  RaftLogEntry,
  RaftNodeConfig,
  IRaftTransport,
} from './raft-consensus';
import { ServiceHealthChecker, HealthStatusChangeEvent } from './health-checker';

/**
 * Registry command types for Raft log entries
 */
export type RegistryCommand =
  | { type: 'REGISTER'; service: ServiceRegistration; timestamp: number }
  | { type: 'DEREGISTER'; serviceId: string; timestamp: number }
  | { type: 'UPDATE_METADATA'; serviceId: string; metadata: Record<string, string>; timestamp: number }
  | { type: 'HEARTBEAT'; serviceId: string; timestamp: number };

/**
 * Service registry configuration
 */
export interface ServiceRegistryConfig {
  nodeId: string;
  peers: string[];
  defaultTTLSeconds: number;
  cleanupIntervalMs: number;
  raft?: Partial<RaftNodeConfig>;
}

/**
 * Internal service entry with TTL tracking
 */
interface ServiceEntry extends ServiceInstance {
  expiresAt: number;
  ttlSeconds: number;
}

/**
 * Default Raft configuration
 */
const DEFAULT_RAFT_CONFIG: RaftNodeConfig = {
  nodeId: '',
  peers: [],
  heartbeatIntervalMs: 100,
  minElectionTimeoutMs: 300,
  maxElectionTimeoutMs: 600,
  maxLogEntriesPerRequest: 100,
};

/**
 * Distributed service registry implementation using Raft consensus
 */
export class DistributedServiceRegistry
  extends EventEmitter
  implements IServiceDiscovery
{
  private services = new Map<string, ServiceEntry>();
  private watches = new Map<string, Set<ServiceWatchCallback>>();
  private raft: RaftConsensusService<RegistryCommand>;
  private healthChecker: ServiceHealthChecker;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private running = false;
  private config: ServiceRegistryConfig;
  private appliedIndex = 0;

  // Stored handler references for symmetric off() cleanup (OOM-003)
  private readonly onCommitted: (args: { command: RegistryCommand }) => void;
  private readonly onBecameLeader: () => void;
  private readonly onBecameFollower: () => void;
  private readonly onHealthStatusChanged: (event: HealthStatusChangeEvent) => void;

  constructor(
    config: ServiceRegistryConfig,
    raft: RaftConsensusService<RegistryCommand>,
    healthChecker: ServiceHealthChecker
  ) {
    super();

    this.config = {
      ...config,
      defaultTTLSeconds: config.defaultTTLSeconds ?? 30,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 10000,
    };

    this.raft = raft;
    this.healthChecker = healthChecker;

    // Bind handlers to named references for symmetric cleanup in stop()
    this.onCommitted = ({ command }) => this.applyCommand(command);
    this.onBecameLeader = () => this.emit('becameLeader', { nodeId: this.config.nodeId });
    this.onBecameFollower = () => this.emit('becameFollower', { nodeId: this.config.nodeId });
    this.onHealthStatusChanged = (event: HealthStatusChangeEvent) => {
      const entry = this.services.get(event.serviceId);
      if (entry) {
        entry.health = event.newStatus;
        entry.lastSeen = new Date();
        this.notifyWatchers(entry.type);
        this.emit('serviceHealthChanged', {
          serviceId: event.serviceId,
          status: event.newStatus,
          reason: event.reason,
        });
      }
    };

    this.setupRaftHandlers();
    this.setupHealthCheckerHandlers();
  }

  /**
   * Start the service registry
   */
  async start(): Promise<void> {
    if (this.running) return;

    await this.raft.start();
    await this.healthChecker.start();

    // Start cleanup timer for expired services
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredServices();
    }, this.config.cleanupIntervalMs);

    this.running = true;
    this.emit('started', { nodeId: this.config.nodeId });
  }

  /**
   * Stop the service registry
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Symmetric unsubscription — prevents EventEmitter listener leaks (OOM-003)
    this.raft.off('committed', this.onCommitted);
    this.raft.off('becameLeader', this.onBecameLeader);
    this.raft.off('becameFollower', this.onBecameFollower);
    this.healthChecker.off('healthStatusChanged', this.onHealthStatusChanged);

    await this.healthChecker.stop();
    await this.raft.stop();

    this.emit('stopped', { nodeId: this.config.nodeId });
  }

  /**
   * Register a service instance
   */
  async register(service: ServiceRegistration): Promise<void> {
    this.ensureRunning();

    if (this.services.has(service.id)) {
      throw new ServiceDiscoveryError(
        'ALREADY_REGISTERED',
        `Service ${service.id} is already registered`,
        service.id
      );
    }

    const command: RegistryCommand = {
      type: 'REGISTER',
      service,
      timestamp: Date.now(),
    };

    try {
      await this.raft.propose(command);
    } catch (error) {
      throw new ServiceDiscoveryError(
        'REGISTRATION_FAILED',
        error instanceof Error ? error.message : 'Failed to register service',
        service.id
      );
    }
  }

  /**
   * Deregister a service instance
   */
  async deregister(serviceId: string): Promise<void> {
    this.ensureRunning();

    if (!this.services.has(serviceId)) {
      throw new ServiceDiscoveryError(
        'INVALID_SERVICE',
        `Service ${serviceId} not found`,
        serviceId
      );
    }

    const command: RegistryCommand = {
      type: 'DEREGISTER',
      serviceId,
      timestamp: Date.now(),
    };

    try {
      await this.raft.propose(command);
    } catch (error) {
      throw new ServiceDiscoveryError(
        'DEREGISTRATION_FAILED',
        error instanceof Error ? error.message : 'Failed to deregister service',
        serviceId
      );
    }
  }

  /**
   * Discover all instances of a service type
   */
  async discover(serviceType: string): Promise<ServiceInstance[]> {
    this.ensureRunning();

    const instances: ServiceInstance[] = [];

    for (const entry of this.services.values()) {
      if (entry.type === serviceType && entry.health === 'HEALTHY') {
        instances.push(this.toServiceInstance(entry));
      }
    }

    // Sort by priority (if set) and return
    return instances.sort((a, b) => (b.leaderPriority || 0) - (a.leaderPriority || 0));
  }

  /**
   * Get a specific service instance by ID
   */
  async getInstance(serviceId: string): Promise<ServiceInstance | null> {
    this.ensureRunning();

    const entry = this.services.get(serviceId);
    if (!entry) return null;

    return this.toServiceInstance(entry);
  }

  /**
   * Watch for changes to service instances of a specific type
   */
  watch(serviceType: string, callback: ServiceWatchCallback): () => void {
    if (!this.watches.has(serviceType)) {
      this.watches.set(serviceType, new Set());
    }

    const callbacks = this.watches.get(serviceType)!;
    callbacks.add(callback);

    // Immediately call with current instances
    const currentInstances = Array.from(this.services.values())
      .filter((entry) => entry.type === serviceType)
      .map((entry) => this.toServiceInstance(entry));

    callback(currentInstances);

    // Return unwatch function
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.watches.delete(serviceType);
      }
    };
  }

  /**
   * Update service metadata
   */
  async updateMetadata(
    serviceId: string,
    metadata: Record<string, string>
  ): Promise<void> {
    this.ensureRunning();

    if (!this.services.has(serviceId)) {
      throw new ServiceDiscoveryError(
        'INVALID_SERVICE',
        `Service ${serviceId} not found`,
        serviceId
      );
    }

    const command: RegistryCommand = {
      type: 'UPDATE_METADATA',
      serviceId,
      metadata,
      timestamp: Date.now(),
    };

    try {
      await this.raft.propose(command);
    } catch (error) {
      throw new ServiceDiscoveryError(
        'UPDATE_FAILED',
        error instanceof Error ? error.message : 'Failed to update metadata',
        serviceId
      );
    }
  }

  /**
   * Refresh service TTL (keepalive)
   */
  async heartbeat(serviceId: string): Promise<void> {
    this.ensureRunning();

    if (!this.services.has(serviceId)) {
      throw new ServiceDiscoveryError(
        'INVALID_SERVICE',
        `Service ${serviceId} not found`,
        serviceId
      );
    }

    const command: RegistryCommand = {
      type: 'HEARTBEAT',
      serviceId,
      timestamp: Date.now(),
    };

    try {
      await this.raft.propose(command);
    } catch (error) {
      // Heartbeat failures are non-critical, just update local state
      this.handleHeartbeat(command);
    }

    // Also notify health checker
    this.healthChecker.heartbeat(serviceId);
  }

  /**
   * Check if the service discovery is available
   */
  isAvailable(): boolean {
    return this.running;
  }

  /**
   * Get current leader node ID
   */
  getLeaderId(): string | null {
    return this.raft.getLeaderId();
  }

  /**
   * Check if this node is the leader
   */
  isLeader(): boolean {
    return this.raft.isLeader();
  }

  /**
   * Get Raft consensus service (for testing/monitoring)
   */
  getRaftService(): RaftConsensusService<RegistryCommand> {
    return this.raft;
  }

  /**
   * Get all registered services (for debugging)
   */
  getAllServices(): ServiceInstance[] {
    return Array.from(this.services.values()).map((entry) =>
      this.toServiceInstance(entry)
    );
  }

  /**
   * Setup Raft event handlers
   */
  private setupRaftHandlers(): void {
    this.raft.on('committed', this.onCommitted);
    this.raft.on('becameLeader', this.onBecameLeader);
    this.raft.on('becameFollower', this.onBecameFollower);
  }

  /**
   * Setup health checker event handlers
   */
  private setupHealthCheckerHandlers(): void {
    this.healthChecker.on('healthStatusChanged', this.onHealthStatusChanged);
  }

  /**
   * Apply a committed command to the state machine
   */
  private applyCommand(command: RegistryCommand): void {
    switch (command.type) {
      case 'REGISTER':
        this.handleRegister(command.service);
        break;
      case 'DEREGISTER':
        this.handleDeregister(command.serviceId);
        break;
      case 'UPDATE_METADATA':
        this.handleUpdateMetadata(command.serviceId, command.metadata);
        break;
      case 'HEARTBEAT':
        this.handleHeartbeat(command);
        break;
    }
  }

  /**
   * Handle REGISTER command
   */
  private handleRegister(service: ServiceRegistration): void {
    const now = Date.now();
    const ttlSeconds = service.ttlSeconds || this.config.defaultTTLSeconds;

    const entry: ServiceEntry = {
      id: service.id,
      type: service.type,
      host: service.host,
      port: service.port,
      metadata: service.metadata || {},
      health: 'STARTING',
      lastSeen: new Date(),
      registeredAt: new Date(),
      expiresAt: now + ttlSeconds * 1000,
      ttlSeconds,
    };

    this.services.set(service.id, entry);

    // Register with health checker
    this.healthChecker.registerService(entry, {
      strategy: service.healthCheckPath ? 'HTTP' : 'PASSIVE',
      httpOptions: service.healthCheckPath
        ? { path: service.healthCheckPath }
        : undefined,
    });

    this.notifyWatchers(service.type);
    this.emit('serviceRegistered', { serviceId: service.id, type: service.type });
  }

  /**
   * Handle DEREGISTER command
   */
  private handleDeregister(serviceId: string): void {
    const entry = this.services.get(serviceId);
    if (!entry) return;

    this.services.delete(serviceId);
    this.healthChecker.unregisterService(serviceId);

    this.notifyWatchers(entry.type);
    this.emit('serviceDeregistered', { serviceId, type: entry.type });
  }

  /**
   * Handle UPDATE_METADATA command
   */
  private handleUpdateMetadata(
    serviceId: string,
    metadata: Record<string, string>
  ): void {
    const entry = this.services.get(serviceId);
    if (!entry) return;

    entry.metadata = { ...entry.metadata, ...metadata };
    entry.lastSeen = new Date();

    this.healthChecker.updateInstance(entry);
    this.notifyWatchers(entry.type);
    this.emit('serviceMetadataUpdated', { serviceId, metadata });
  }

  /**
   * Handle HEARTBEAT command
   */
  private handleHeartbeat(command: RegistryCommand & { type: 'HEARTBEAT' }): void {
    const entry = this.services.get(command.serviceId);
    if (!entry) return;

    entry.lastSeen = new Date();
    entry.expiresAt = command.timestamp + entry.ttlSeconds * 1000;

    if (entry.health === 'STOPPING') {
      entry.health = 'HEALTHY';
    }
  }

  /**
   * Notify watchers of service type changes
   */
  private notifyWatchers(serviceType: string): void {
    const callbacks = this.watches.get(serviceType);
    if (!callbacks || callbacks.size === 0) return;

    const instances = Array.from(this.services.values())
      .filter((entry) => entry.type === serviceType)
      .map((entry) => this.toServiceInstance(entry));

    for (const callback of callbacks) {
      try {
        callback(instances);
      } catch (error) {
        this.emit('watchError', { serviceType, error });
      }
    }
  }

  /**
   * Cleanup expired services
   */
  private cleanupExpiredServices(): void {
    const now = Date.now();

    for (const [serviceId, entry] of this.services.entries()) {
      if (entry.expiresAt < now && entry.health !== 'STOPPING') {
        entry.health = 'STOPPING';

        // Try to deregister through Raft if leader
        if (this.raft.isLeader()) {
          this.deregister(serviceId).catch(() => {
            // If deregistration fails, remove locally
            this.services.delete(serviceId);
            this.healthChecker.unregisterService(serviceId);
            this.notifyWatchers(entry.type);
          });
        }
      }
    }
  }

  /**
   * Convert internal entry to ServiceInstance
   */
  private toServiceInstance(entry: ServiceEntry): ServiceInstance {
    const { expiresAt, ttlSeconds, ...instance } = entry;
    return instance;
  }

  /**
   * Ensure registry is running
   */
  private ensureRunning(): void {
    if (!this.running) {
      throw new ServiceDiscoveryError(
        'CONSENSUS_UNAVAILABLE',
        'Service registry is not running'
      );
    }
  }
}
