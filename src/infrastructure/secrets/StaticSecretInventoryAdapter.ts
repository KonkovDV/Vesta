import type {
  ISecretInventory,
  SecretRotationTarget,
} from '@/domain/security/secret-inventory.port';

const STATIC_SECRET_TARGETS: SecretRotationTarget[] = [
  {
    id: 'POSTGRES_PASSWORD',
    kind: 'database-credential',
    provider: 'env',
    supportsAutomatedRotation: false,
    requiresHumanApproval: true,
    description: 'Primary Postgres password used by the runtime database connection',
  },
  {
    id: 'REDIS_PASSWORD',
    kind: 'cache-credential',
    provider: 'env',
    supportsAutomatedRotation: false,
    requiresHumanApproval: true,
    description: 'Redis password for queueing and cache infrastructure',
  },
  {
    id: 'JWT_SECRET',
    kind: 'application-secret',
    provider: 'env',
    supportsAutomatedRotation: false,
    requiresHumanApproval: true,
    description: 'Application JWT signing secret',
  },
  {
    id: 'ENCRYPTION_KEY',
    kind: 'encryption-key',
    provider: 'env',
    supportsAutomatedRotation: false,
    requiresHumanApproval: true,
    description: 'Envelope encryption key for sensitive data',
  },
  {
    id: 'OPENAI_API_KEY',
    kind: 'third-party-api-key',
    provider: 'env',
    supportsAutomatedRotation: false,
    requiresHumanApproval: true,
    description: 'Upstream LLM provider API key',
  },
];

export class StaticSecretInventoryAdapter implements ISecretInventory {
  async listTargets(): Promise<readonly SecretRotationTarget[]> {
    return STATIC_SECRET_TARGETS;
  }

  async getTargetsByIds(targetIds: readonly string[]): Promise<SecretRotationTarget[]> {
    const requested = new Set(targetIds);
    return STATIC_SECRET_TARGETS.filter((target) => requested.has(target.id));
  }
}