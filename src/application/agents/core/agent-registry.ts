/**
 * MAS Runtime Core - Agent Registry contract.
 *
 * Layer: Application (business orchestration).
 *
 * Agent Registry is responsible for:
 * - exposing available agents and their capabilities to Master Agent;
 * - selecting suitable agents based on criteria;
 * - providing read-only metadata about agents in v1.
 *
 * This is a pure contract; implementations live in impl/config layers.
 */

import type {
  AgentDescriptor,
  AgentSelectionCriteria,
  AgentId,
  MasMetadataBag,
} from '../types/mas-types';

/**
 * Snapshot of known agents at a given point in time.
 */
export interface AgentRegistrySnapshot {
  /** All agents currently known to the registry. */
  agents: AgentDescriptor[];
  /** Time at which snapshot was generated. */
  generatedAt: Date;
  /** Optional opaque metadata (e.g. source, version). */
  metadata?: MasMetadataBag;
}

/**
 * Agent Registry interface.
 */
export interface IAgentRegistry {
  /**
   * Find agents matching given selection criteria.
   */
  findAgents(criteria: AgentSelectionCriteria): Promise<AgentDescriptor[]>;

  /**
   * Get a single agent by identifier.
   */
  getAgentById(id: AgentId): Promise<AgentDescriptor | null>;

  /**
   * Retrieve a snapshot of all agents known to this registry.
   */
  listAllAgents(): Promise<AgentRegistrySnapshot>;
}

/**
 * DI token for IAgentRegistry.
 *
 * Implementations (e.g. AgentRegistryStaticV1) are registered in the
 * infrastructure DI bootstrap, while MAS core and MasterAgent use this
 * token for resolving the registry from the shared container.
 */
export const agentRegistryToken = 'IAgentRegistry' as const;
export type AgentRegistryDiToken = typeof agentRegistryToken;