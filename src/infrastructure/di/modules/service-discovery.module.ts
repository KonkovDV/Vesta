/**
 * Service Discovery DI Module
 * Registers Service Discovery services with the DI container.
 * Layer: Infrastructure/DI
 */

import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import { IServiceDiscovery } from '../../../domain/service-discovery';
import {
  DistributedServiceRegistry,
  ServiceRegistryConfig,
  RegistryCommand,
  IRaftTransport,
  RaftConsensusService,
  RaftNodeConfig,
  ServiceHealthChecker,
} from '../../service-discovery';
import { getConfig } from '../../../config';

/**
 * Service discovery module configuration
 */
export interface ServiceDiscoveryModuleConfig {
  nodeId: string;
  peers: string[];
  enabled: boolean;
  defaultTTLSeconds: number;
  cleanupIntervalMs: number;
  raftHeartbeatIntervalMs: number;
  raftElectionTimeoutMinMs: number;
  raftElectionTimeoutMaxMs: number;
}

let registryInstance: DistributedServiceRegistry | null = null;

/**
 * In-memory transport for single-node deployments (testing/fallback)
 */
class InMemoryRaftTransport implements IRaftTransport {
  private nodes = new Map<string, DistributedServiceRegistry>();

  registerNode(nodeId: string, registry: DistributedServiceRegistry): void {
    this.nodes.set(nodeId, registry);
  }

  async sendRequestVote(
    targetNodeId: string,
    request: import('../../service-discovery/raft-consensus').RequestVoteRequest
  ): Promise<import('../../service-discovery/raft-consensus').RequestVoteResponse> {
    // In single-node mode, always grant vote
    return {
      term: request.term,
      voteGranted: true,
      voterId: targetNodeId,
    };
  }

  async sendAppendEntries<T>(
    targetNodeId: string,
    request: import('../../service-discovery/raft-consensus').AppendEntriesRequest<T>
  ): Promise<import('../../service-discovery/raft-consensus').AppendEntriesResponse> {
    return {
      term: request.term,
      success: true,
      nodeId: targetNodeId,
      matchIndex: request.prevLogIndex + request.entries.length,
    };
  }

  async broadcastRequestVote(
    request: import('../../service-discovery/raft-consensus').RequestVoteRequest
  ): Promise<import('../../service-discovery/raft-consensus').RequestVoteResponse[]> {
    return [];
  }

  async broadcastAppendEntries<T>(
    request: import('../../service-discovery/raft-consensus').AppendEntriesRequest<T>
  ): Promise<import('../../service-discovery/raft-consensus').AppendEntriesResponse[]> {
    return [];
  }
}

// Singleton transport instance
const inMemoryTransport = new InMemoryRaftTransport();

/**
 * Register Service Discovery services with DI container
 */
export function registerServiceDiscoveryServices(): void {
  try {
    const cfg = getConfig() as Record<string, string | undefined>;
    const enabled = cfg.SERVICE_DISCOVERY_ENABLED !== 'false';

    if (!enabled) {
      console.log('⏭ Service Discovery disabled (SERVICE_DISCOVERY_ENABLED=false)');
      return;
    }

    const nodeId = cfg.SERVICE_DISCOVERY_NODE_ID || cfg.AGENT_ID || 'node-1';
    const peers = cfg.SERVICE_DISCOVERY_PEERS
      ? cfg.SERVICE_DISCOVERY_PEERS.split(',')
      : [];
    const defaultTTLSeconds = parseInt(cfg.SERVICE_DISCOVERY_TTL_SECONDS || '30', 10);
    const cleanupIntervalMs = parseInt(
      cfg.SERVICE_DISCOVERY_CLEANUP_INTERVAL_MS || '10000',
      10
    );
    const raftHeartbeatIntervalMs = parseInt(
      cfg.SERVICE_DISCOVERY_RAFT_HEARTBEAT_MS || '100',
      10
    );
    const raftElectionTimeoutMinMs = parseInt(
      cfg.SERVICE_DISCOVERY_RAFT_ELECTION_MIN_MS || '300',
      10
    );
    const raftElectionTimeoutMaxMs = parseInt(
      cfg.SERVICE_DISCOVERY_RAFT_ELECTION_MAX_MS || '600',
      10
    );

    console.log(`🔍 Registering Service Discovery services (nodeId=${nodeId})...`);

    // Register module configuration
    container.register<ServiceDiscoveryModuleConfig>(
      'ServiceDiscoveryModuleConfig',
      () => ({
        nodeId,
        peers,
        enabled,
        defaultTTLSeconds,
        cleanupIntervalMs,
        raftHeartbeatIntervalMs,
        raftElectionTimeoutMinMs,
        raftElectionTimeoutMaxMs,
      }),
      {
        lifecycle: 'singleton',
        tags: ['service-discovery', 'config'],
        description: 'Service discovery module configuration',
      }
    );

    // Register IServiceDiscovery
    container.register<IServiceDiscovery>(
      'IServiceDiscovery',
      () => {
        const provider = cfg.SERVICE_DISCOVERY_PROVIDER || 'raft';

        // mDNS (Bonjour) Provider
        if (provider === 'bonjour') {
            const { BonjourDiscoveryService } = require('../../service-discovery/bonjour-discovery');
            return new BonjourDiscoveryService({ nodeId });
        }

        // Default: Raft Consensus Provider
        if (!registryInstance) {
          const config: ServiceRegistryConfig = {
            nodeId,
            peers,
            defaultTTLSeconds,
            cleanupIntervalMs,
            raft: {
              heartbeatIntervalMs: raftHeartbeatIntervalMs,
              minElectionTimeoutMs: raftElectionTimeoutMinMs,
              maxElectionTimeoutMs: raftElectionTimeoutMaxMs,
            },
          };

          // Create Raft config from registry config
          const raftConfig: RaftNodeConfig = {
            nodeId,
            peers,
            heartbeatIntervalMs: raftHeartbeatIntervalMs,
            minElectionTimeoutMs: raftElectionTimeoutMinMs,
            maxElectionTimeoutMs: raftElectionTimeoutMaxMs,
            maxLogEntriesPerRequest: 100,
          };

          // Create dependencies (within DI factory is acceptable)
          const raft = new RaftConsensusService<RegistryCommand>(raftConfig, inMemoryTransport);
          const healthChecker = new ServiceHealthChecker();

          registryInstance = new DistributedServiceRegistry(
            config,
            raft,
            healthChecker
          );

          // Register with transport for single-node mode
          inMemoryTransport.registerNode(nodeId, registryInstance);
        }
        return registryInstance;
      },
      {
        lifecycle: 'singleton',
        tags: ['service-discovery', 'registry', 'raft', 'core'],
        description:
          'Distributed service registry with Raft consensus for cloud-native service discovery',
      }
    );

    // Register DistributedServiceRegistry directly (for advanced usage)
    container.register<DistributedServiceRegistry>(
      'DistributedServiceRegistry',
      (c) => c.resolve<IServiceDiscovery>(DI_TOKENS.IServiceDiscovery) as DistributedServiceRegistry,
      {
        lifecycle: 'singleton',
        tags: ['service-discovery', 'registry'],
        description: 'Distributed service registry implementation',
      }
    );

    console.log('✓ Service Discovery services registered');
  } catch (error) {
    console.error('✗ Failed to register Service Discovery services:', error);
    throw error;
  }
}

/**
 * Initialize service discovery services
 */
export async function initializeServiceDiscoveryServices(): Promise<void> {
  try {
    if (registryInstance) {
      await registryInstance.start();
      console.log('✓ Service Discovery registry started');
    }
  } catch (error) {
    console.error('✗ Failed to start Service Discovery:', error);
    throw error;
  }
}

/**
 * Shutdown service discovery services
 */
export async function shutdownServiceDiscoveryServices(): Promise<void> {
  try {
    if (registryInstance) {
      await registryInstance.stop();
      registryInstance = null;
      console.log('✓ Service Discovery registry stopped');
    }
  } catch (error) {
    console.error('✗ Failed to shutdown Service Discovery:', error);
    throw error;
  }
}

/**
 * Get the configured registry instance
 */
export function getServiceDiscoveryInstance(): DistributedServiceRegistry | null {
  return registryInstance;
}
