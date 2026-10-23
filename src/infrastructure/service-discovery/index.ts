/**
 * Service Discovery Infrastructure Exports
 * Layer: Infrastructure
 */

// Classes
export { RaftConsensusService } from './raft-consensus';
export { ServiceHealthChecker } from './health-checker';
export { DistributedServiceRegistry } from './service-registry';

// Types from raft-consensus
export type {
  RaftNodeState,
  RaftLogEntry,
  RaftNodeConfig,
  RequestVoteRequest,
  RequestVoteResponse,
  AppendEntriesRequest,
  AppendEntriesResponse,
  CommitEvent,
  IRaftTransport,
} from './raft-consensus';

// Types from health-checker
export type {
  HealthCheckConfig,
  HealthCheckResult,
  HealthCheckStrategy,
  HttpHealthCheckOptions,
  ServiceHealthOptions,
  HealthStatusChangeEvent,
} from './health-checker';

// Types from service-registry
export type {
  ServiceRegistryConfig,
  RegistryCommand,
} from './service-registry';
