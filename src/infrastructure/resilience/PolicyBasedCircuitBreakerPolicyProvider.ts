import type {
  ICircuitBreakerPolicyProvider,
} from '../../core/resilience/ICircuitBreakerPolicyProvider';
import type {
  CircuitBreakerKey,
  CircuitBreakerChannel,
} from '../../core/resilience/CircuitBreakerKey';
import type { CircuitBreakerConfig } from '../../core/resilience/CircuitBreakerConfig';

type EnvGroup = 'dev' | 'prod';

interface ServicePolicy {
  /** Base override applied for all operations of the service. */
  config?: Partial<CircuitBreakerConfig>;
  /** Optional per-operation overrides (method name from CircuitBreakerKey.operation). */
  operations?: Record<string, Partial<CircuitBreakerConfig>>;
}

interface ChannelPolicies {
  /** Channel-level default override for this environment group. */
  defaultConfig?: Partial<CircuitBreakerConfig>;
  /** Optional per-service policies keyed by CircuitBreakerKey.serviceName. */
  services?: Record<string, ServicePolicy>;
}

type PolicyTable = {
  [channel in CircuitBreakerChannel]?: ChannelPolicies;
};

function resolveEnvGroup(environment: string): EnvGroup {
  const normalized = environment.toLowerCase();
  if (
    normalized === 'production' ||
    normalized === 'prod' ||
    normalized === 'stage' ||
    normalized === 'staging'
  ) {
    return 'prod';
  }
  return 'dev';
}

const DEV_POLICIES: PolicyTable = {
  LLM: {
    defaultConfig: {
      failureThreshold: 3,
      successThreshold: 1,
      openStateDurationMs: 30_000,
      halfOpenProbeCount: 3,
      slidingWindowSize: 20,
    },
    services: {
      OpenAILLM: {
        config: {
          name: 'cb.llm.openai.dev',
          failureThreshold: 2,
          successThreshold: 1,
          openStateDurationMs: 30_000,
          halfOpenProbeCount: 2,
          slidingWindowSize: 10,
        },
        operations: {
          generateText: {
            // Slightly higher probe count for generateText to confirm recovery.
            halfOpenProbeCount: 3,
          },
        },
      },
    },
  },
  MEMORY: {
    defaultConfig: {
      failureThreshold: 4,
      successThreshold: 1,
      openStateDurationMs: 45_000,
      halfOpenProbeCount: 3,
      slidingWindowSize: 20,
    },
    services: {
      OpenMemoryHSGClient: {
        config: {
          name: 'cb.memory.openmemory.dev',
          failureThreshold: 4,
          successThreshold: 1,
          openStateDurationMs: 30_000,
          halfOpenProbeCount: 3,
          slidingWindowSize: 20,
        },
      },
      QdrantVectorClient: {
        config: {
          name: 'cb.memory.qdrant_vector.dev',
          failureThreshold: 4,
          successThreshold: 1,
          openStateDurationMs: 30_000,
          halfOpenProbeCount: 3,
          slidingWindowSize: 20,
        },
      },
    },
  },
  HTTP: {
    defaultConfig: {
      failureThreshold: 3,
      successThreshold: 1,
      openStateDurationMs: 30_000,
      halfOpenProbeCount: 3,
      slidingWindowSize: 20,
    },
    services: {
      SlackHttpClient: {
        config: {
          name: 'cb.http.slack.dev',
          failureThreshold: 2,
          successThreshold: 1,
          openStateDurationMs: 20_000,
          halfOpenProbeCount: 2,
          slidingWindowSize: 10,
        },
      },
    },
  },
};

const PROD_POLICIES: PolicyTable = {
  LLM: {
    defaultConfig: {
      failureThreshold: 4,
      successThreshold: 2,
      openStateDurationMs: 60_000,
      halfOpenProbeCount: 5,
      slidingWindowSize: 50,
    },
    services: {
      OpenAILLM: {
        config: {
          name: 'cb.llm.openai.prod',
          failureThreshold: 3,
          successThreshold: 2,
          openStateDurationMs: 90_000,
          halfOpenProbeCount: 5,
          slidingWindowSize: 50,
        },
      },
    },
  },
  MEMORY: {
    defaultConfig: {
      failureThreshold: 5,
      successThreshold: 2,
      openStateDurationMs: 60_000,
      halfOpenProbeCount: 5,
      slidingWindowSize: 50,
    },
    services: {
      OpenMemoryHSGClient: {
        config: {
          name: 'cb.memory.openmemory.prod',
          failureThreshold: 6,
          successThreshold: 2,
          openStateDurationMs: 60_000,
          halfOpenProbeCount: 5,
          slidingWindowSize: 50,
        },
      },
      QdrantVectorClient: {
        config: {
          name: 'cb.memory.qdrant_vector.prod',
          failureThreshold: 6,
          successThreshold: 2,
          openStateDurationMs: 60_000,
          halfOpenProbeCount: 5,
          slidingWindowSize: 50,
        },
      },
    },
  },
  HTTP: {
    defaultConfig: {
      failureThreshold: 3,
      successThreshold: 1,
      openStateDurationMs: 45_000,
      halfOpenProbeCount: 3,
      slidingWindowSize: 30,
    },
    services: {
      SlackHttpClient: {
        config: {
          name: 'cb.http.slack.prod',
          failureThreshold: 2,
          successThreshold: 1,
          openStateDurationMs: 60_000,
          halfOpenProbeCount: 2,
          slidingWindowSize: 20,
        },
      },
    },
  },
};

function getPoliciesForEnv(environment: string): PolicyTable {
  const group = resolveEnvGroup(environment);
  return group === 'prod' ? PROD_POLICIES : DEV_POLICIES;
}

export class PolicyBasedCircuitBreakerPolicyProvider
  implements ICircuitBreakerPolicyProvider
{
  getConfigOverride(
    key: CircuitBreakerKey,
  ): Partial<CircuitBreakerConfig> | null | undefined {
    const table = getPoliciesForEnv(key.environment);
    const channelPolicies = table[key.channel];
    if (!channelPolicies) {
      return undefined;
    }

    const servicePolicies = channelPolicies.services?.[key.serviceName];

    const pieces: Partial<CircuitBreakerConfig>[] = [];

    if (channelPolicies.defaultConfig) {
      pieces.push(channelPolicies.defaultConfig);
    }

    if (servicePolicies?.config) {
      pieces.push(servicePolicies.config);
    }

    const opOverride = servicePolicies?.operations?.[key.operation];
    if (opOverride) {
      pieces.push(opOverride);
    }

    if (pieces.length === 0) {
      return undefined;
    }

    // Shallow merge: later pieces override earlier ones.
    return pieces.reduce<Partial<CircuitBreakerConfig>>(
      (acc, part) => Object.assign(acc, part),
      {},
    );
  }
}