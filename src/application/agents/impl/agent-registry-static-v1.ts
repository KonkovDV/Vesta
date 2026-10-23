/**
 * MAS Runtime Core - AgentRegistryStaticV1 implementation.
 *
 * Layer: Application (business orchestration).
 *
 * MAS-A1.5 scope:
 * - static, in-memory registry of MAS agents;
 * - no I/O, no DI or infrastructure dependencies;
 * - deterministic selection of agents based on capabilities/modality/trust level.
 */
import type {
  AgentDescriptor,
  AgentSelectionCriteria,
  AgentId,
  AgentModality,
  MasMetadataBag,
  MasFilterBag,
} from '../types/mas-types';
import type {
  IAgentRegistry,
  AgentRegistrySnapshot,
} from '../core/agent-registry';

type AgentHealthStatus = 'healthy' | 'degraded' | 'unavailable';

interface AgentRegistryMetadata extends MasMetadataBag {
  /** Logical role of the agent inside MAS (planner/executor/critic/etc.). */
  role: string;
  /** Marker that this agent can be used as a generic fallback. */
  isFallback?: boolean;
  /** Health information used internally for filtering. */
  health: {
    status: AgentHealthStatus;
    reason?: string;
  };
}

type InternalAgentDescriptor = AgentDescriptor;

const STATIC_AGENTS: readonly InternalAgentDescriptor[] = [
  {
    id: 'mas.memory.planner' as AgentId,
    name: 'MAS Memory Planner',
    description:
      'Planner agent responsible for analyzing and planning interactions with MAS memory layer.',
    modalities: ['text', 'tool'],
    capabilities: [
      { tag: 'memory_analysis' },
      { tag: 'memory_planning' },
      { tag: 'planning' },
    ],
    trustLevel: 0.9,
    metadata: {
      role: 'memory_planner',
      health: {
        status: 'healthy',
      },
    },
  },
  {
    id: 'mas.usecases.planner' as AgentId,
    name: 'MAS Use-Case Planner',
    description:
      'Planner agent that decomposes high-level user requests into use-case level plans.',
    modalities: ['text'],
    capabilities: [
      { tag: 'planning' },
      { tag: 'usecase_planning' },
    ],
    trustLevel: 0.95,
    metadata: {
      role: 'planner',
      health: {
        status: 'healthy',
      },
    },
  },
  {
    id: 'mas.generic.assistant' as AgentId,
    name: 'MAS Generic Assistant',
    description:
      'Generic assistant agent used as a fallback when no specialized agent matches.',
    modalities: ['text', 'voice'],
    capabilities: [
      { tag: 'generic_assistant' },
    ],
    trustLevel: 0.8,
    metadata: {
      role: 'assistant',
      isFallback: true,
      health: {
        status: 'healthy',
      },
    },
  },
  {
    id: 'mas.security.audit' as AgentId,
    name: 'MAS Security Auditor',
    description:
      'Security-focused agent intended for audit and compliance analysis.',
    modalities: ['text'],
    capabilities: [
      { tag: 'security_audit' },
      { tag: 'compliance_review' },
    ],
    trustLevel: 0.85,
    metadata: {
      role: 'auditor',
      health: {
        status: 'unavailable',
        reason: 'Temporarily disabled in static configuration.',
      },
    },
  },
] as const;

export class AgentRegistryStaticV1 implements IAgentRegistry {
  private readonly agents: readonly InternalAgentDescriptor[];

  constructor() {
    this.agents = STATIC_AGENTS;
  }

  async findAgents(
    criteria: AgentSelectionCriteria,
  ): Promise<AgentDescriptor[]> {
    const requiredTags = this.extractRequiredTags(criteria);
    const preferredRole = this.extractPreferredRole(criteria);
    const preferredAgentIds = new Set<string>(
      (criteria.preferredAgentIds ?? []).map(id => String(id)),
    );
    const minTrustLevel = criteria.minTrustLevel;

    const baseCandidates = this.agents.filter(agent => {
      if (this.getHealthStatus(agent) === 'unavailable') {
        return false;
      }

      if (!this.matchesModalities(agent, criteria.modalities)) {
        return false;
      }

      if (typeof minTrustLevel === 'number') {
        const trust = typeof agent.trustLevel === 'number' ? agent.trustLevel : 0;
        if (trust < minTrustLevel) {
          return false;
        }
      }

      if (preferredRole && this.getRole(agent) !== preferredRole) {
        return false;
      }

      return true;
    });

    if (baseCandidates.length === 0) {
      return [];
    }

    // No required capabilities: return all filtered agents in deterministic order.
    if (requiredTags.length === 0) {
      const sorted = [...baseCandidates].sort((a, b) =>
        this.compareAgents(a, b, preferredAgentIds),
      );
      return sorted.map(agent => this.cloneAgentDescriptor(agent));
    }

    const scored = baseCandidates
      .map(agent => {
        const matchCount = this.computeCapabilityMatchCount(agent, requiredTags);
        return { agent, matchCount };
      })
      .filter(entry => entry.matchCount > 0);

    if (scored.length === 0) {
      const fallbackAgents = baseCandidates.filter(agent =>
        this.isFallbackAgent(agent),
      );

      if (fallbackAgents.length === 0) {
        return [];
      }

      const sortedFallback = [...fallbackAgents].sort((a, b) =>
        this.compareAgents(a, b, preferredAgentIds),
      );

      return sortedFallback.map(agent => this.cloneAgentDescriptor(agent));
    }

    scored.sort((a, b) => {
      if (b.matchCount !== a.matchCount) {
        return b.matchCount - a.matchCount;
      }
      return this.compareAgents(a.agent, b.agent, preferredAgentIds);
    });

    return scored.map(entry => this.cloneAgentDescriptor(entry.agent));
  }

  async getAgentById(id: AgentId): Promise<AgentDescriptor | null> {
    const found = this.agents.find(agent => agent.id === id);
    if (!found) {
      return null;
    }

    return this.cloneAgentDescriptor(found);
  }

  async listAllAgents(): Promise<AgentRegistrySnapshot> {
    const now = new Date();
    const agents = this.agents.map(agent => this.cloneAgentDescriptor(agent));

    return {
      agents,
      generatedAt: now,
      metadata: {
        source: 'AgentRegistryStaticV1',
        totalAgents: this.agents.length,
      },
    };
  }

  private extractRequiredTags(criteria: AgentSelectionCriteria): string[] {
    const tags = new Set<string>();

    if (criteria.requiredCapabilityTags) {
      for (const tag of criteria.requiredCapabilityTags) {
        if (tag && tag.trim()) {
          tags.add(tag.trim().toLowerCase());
        }
      }
    }

    if (criteria.requiredCapabilities) {
      for (const capability of criteria.requiredCapabilities) {
        const tag = capability?.tag?.trim();
        if (tag) {
          tags.add(tag.toLowerCase());
        }
      }
    }

    return Array.from(tags);
  }

  private extractPreferredRole(
    criteria: AgentSelectionCriteria,
  ): string | undefined {
    const filters = criteria.additionalFilters;
    if (!filters || typeof filters !== 'object') {
      return undefined;
    }

    const preferredRole = (filters).preferredRole;
    return typeof preferredRole === 'string' ? preferredRole : undefined;
  }

  private matchesModalities(
    agent: AgentDescriptor,
    desired?: AgentModality | AgentModality[],
  ): boolean {
    if (!desired) {
      return true;
    }

    const desiredList = Array.isArray(desired) ? desired : [desired];
    const agentModalities = this.getAgentModalities(agent);

    return desiredList.some(modality => agentModalities.includes(modality));
  }

  private getAgentModalities(agent: AgentDescriptor): AgentModality[] {
    if (agent.modalities && agent.modalities.length > 0) {
      return agent.modalities;
    }

    // In static registry, missing modalities default to text-only.
    return ['text'];
  }

  private computeCapabilityMatchCount(
    agent: AgentDescriptor,
    requiredTags: string[],
  ): number {
    if (requiredTags.length === 0) {
      return 0;
    }

    const agentTags = agent.capabilities.map(cap => cap.tag.toLowerCase());
    let count = 0;

    for (const required of requiredTags) {
      if (agentTags.includes(required)) {
        count += 1;
      }
    }

    return count;
  }

  private compareAgents(
    a: AgentDescriptor,
    b: AgentDescriptor,
    preferredIds: Set<string>,
  ): number {
    const aPreferred = preferredIds.has(String(a.id));
    const bPreferred = preferredIds.has(String(b.id));

    if (aPreferred !== bPreferred) {
      return aPreferred ? -1 : 1;
    }

    return String(a.id).localeCompare(String(b.id));
  }

  private getHealthStatus(agent: AgentDescriptor): AgentHealthStatus {
    const metadata = agent.metadata as AgentRegistryMetadata | undefined;
    const health = metadata?.health;
    if (!health) {
      return 'healthy';
    }

    if (health.status === 'degraded' || health.status === 'unavailable') {
      return health.status;
    }

    return 'healthy';
  }

  private getRole(agent: AgentDescriptor): string | undefined {
    const metadata = agent.metadata as AgentRegistryMetadata | undefined;
    return metadata?.role;
  }

  private isFallbackAgent(agent: AgentDescriptor): boolean {
    const metadata = agent.metadata as AgentRegistryMetadata | undefined;
    return Boolean(metadata?.isFallback);
  }

  private cloneAgentDescriptor(agent: AgentDescriptor): AgentDescriptor {
    return {
      ...agent,
      modalities: agent.modalities ? [...agent.modalities] : undefined,
      capabilities: agent.capabilities.map(capability => ({
        ...capability,
        metadata: capability.metadata
          ? { ...capability.metadata }
          : undefined,
      })),
      limits: agent.limits ? { ...agent.limits } : undefined,
      metadata: agent.metadata
        ? this.cloneMetadata(agent.metadata)
        : undefined,
    };
  }

  private cloneMetadata(
    metadata: MasMetadataBag,
  ): MasMetadataBag {
    const cloned: MasMetadataBag = {};

    for (const [key, value] of Object.entries(metadata)) {
      if (Array.isArray(value)) {
        cloned[key] = [...value];
      } else if (value && typeof value === 'object') {
        cloned[key] = { ...(value as MasMetadataBag) };
      } else {
        cloned[key] = value;
      }
    }

    return cloned;
  }
}