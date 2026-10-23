/**
 * Service Discovery Domain Exports
 * Layer: Domain
 */

export type {
  IServiceDiscovery,
  ServiceRegistration,
  ServiceInstance,
  ServiceDiscoveryEvent,
  ServiceWatchCallback,
  HealthStatus,
  ServiceDiscoveryErrorCode,
} from './service-discovery.port';

export { ServiceDiscoveryError } from './service-discovery.port';
