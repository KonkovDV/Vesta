/**
 * Service Discovery Port
 * Domain layer contract for service registration and discovery.
 * Layer: Domain
 *
 * Enables cloud-native service discovery with consensus-based replication.
 * Replaces mDNS for Kubernetes and cloud environments.
 */

/**
 * Service health status
 */
export type HealthStatus =
  | 'HEALTHY'
  | 'UNHEALTHY'
  | 'DEGRADED'
  | 'UNKNOWN'
  | 'STARTING'
  | 'STOPPING';

/**
 * Service registration request
 */
export interface ServiceRegistration {
  id: string;
  type: string;
  host: string;
  port: number;
  metadata?: Record<string, string>;
  healthCheckPath?: string;
  ttlSeconds?: number;
}

/**
 * Service instance information
 */
export interface ServiceInstance {
  id: string;
  type: string;
  host: string;
  port: number;
  metadata: Record<string, string>;
  health: HealthStatus;
  lastSeen: Date;
  registeredAt: Date;
  leaderPriority?: number;
}

/**
 * Service discovery change event
 */
export interface ServiceDiscoveryEvent {
  type: 'REGISTERED' | 'DEREGISTERED' | 'HEALTH_CHANGED' | 'METADATA_UPDATED';
  serviceId: string;
  serviceType: string;
  instance: ServiceInstance;
  timestamp: Date;
}

/**
 * Watch callback for service changes
 */
export type ServiceWatchCallback = (instances: ServiceInstance[]) => void;

/**
 * Service discovery error types
 */
export type ServiceDiscoveryErrorCode =
  | 'REGISTRATION_FAILED'
  | 'DEREGISTRATION_FAILED'
  | 'DISCOVERY_FAILED'
  | 'UPDATE_FAILED'
  | 'CONSENSUS_UNAVAILABLE'
  | 'UNAUTHORIZED'
  | 'TIMEOUT'
  | 'INVALID_SERVICE'
  | 'ALREADY_REGISTERED';

/**
 * Service discovery error
 */
export class ServiceDiscoveryError extends Error {
  constructor(
    public readonly code: ServiceDiscoveryErrorCode,
    message: string,
    public readonly serviceId?: string
  ) {
    super(message);
    this.name = 'ServiceDiscoveryError';
  }
}

/**
 * Service discovery port interface
 * Contract for service registration and discovery implementations
 */
export interface IServiceDiscovery {
  /**
   * Register a service instance
   * @param service Service registration details
   * @throws ServiceDiscoveryError if registration fails
   */
  register(service: ServiceRegistration): Promise<void>;

  /**
   * Deregister a service instance
   * @param serviceId Unique service identifier
   * @throws ServiceDiscoveryError if deregistration fails
   */
  deregister(serviceId: string): Promise<void>;

  /**
   * Discover all instances of a service type
   * @param serviceType Type of service to discover
   * @returns Array of healthy service instances
   * @throws ServiceDiscoveryError if discovery fails
   */
  discover(serviceType: string): Promise<ServiceInstance[]>;

  /**
   * Get a specific service instance by ID
   * @param serviceId Unique service identifier
   * @returns Service instance or null if not found
   */
  getInstance(serviceId: string): Promise<ServiceInstance | null>;

  /**
   * Watch for changes to service instances of a specific type
   * @param serviceType Type of service to watch
   * @param callback Function called when instances change
   * @returns Unwatch function to stop watching
   */
  watch(serviceType: string, callback: ServiceWatchCallback): () => void;

  /**
   * Update service metadata
   * @param serviceId Unique service identifier
   * @param metadata Updated metadata
   */
  updateMetadata(serviceId: string, metadata: Record<string, string>): Promise<void>;

  /**
   * Refresh service TTL (keepalive)
   * @param serviceId Unique service identifier
   */
  heartbeat(serviceId: string): Promise<void>;

  /**
   * Check if the service discovery is available
   */
  isAvailable(): boolean;

  /**
   * Get current leader node ID (if applicable)
   */
  getLeaderId(): string | null;
}
