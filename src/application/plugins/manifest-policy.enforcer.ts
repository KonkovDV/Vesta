import type {
  PluginManifestId,
  PluginManifestSnapshot,
  IPluginManifestStore,
} from '../../domain/plugins/manifest/plugin-manifest-store.interface';
import { getPolicyDenialsCounter, getPolicyEvaluationsCounter } from '../../monitoring';

type ManifestRawTrust = {
  tier?: string;
  risk_level?: string;
};

type ManifestRawCapabilities = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  network?: { egress_allow?: any[]; ingress?: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filesystem?: { read?: any[]; write?: any[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env_allow?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  secrets?: any[];
  [key: string]: unknown;
};

type ManifestRaw = {
  trust?: ManifestRawTrust;
  capabilities?: ManifestRawCapabilities;
  [key: string]: unknown;
};

export type ManifestEnforcementStatus = 'allow' | 'deny';

export type ManifestEnforcementReason =
  | 'ok'
  | 'manifest_not_found'
  | 'manifest_store_error'
  | 'identity_mismatch'
  | 'trust_policy_violation'
  | 'internal_error';

export interface ManifestEnforcementContext {
  pluginId: PluginManifestId;
  // TODO (следующие подзадачи): добавить поля tenant/region/dataClasses и т.п.
}

export interface ManifestEnforcementDecision {
  status: ManifestEnforcementStatus;
  reason: ManifestEnforcementReason;
  manifest?: PluginManifestSnapshot;
  errorMessage?: string;
}

export interface IManifestPolicyEnforcer {
  enforce(context: ManifestEnforcementContext): Promise<ManifestEnforcementDecision>;
}

const manifestPolicyEvaluations = getPolicyEvaluationsCounter();
const manifestPolicyDenials = getPolicyDenialsCounter();
const MANIFEST_POLICY_SOURCE = 'plugins_inline';

export class ManifestPolicyEnforcer implements IManifestPolicyEnforcer {
  constructor(private readonly manifestStore: IPluginManifestStore) {}

  async enforce(context: ManifestEnforcementContext): Promise<ManifestEnforcementDecision> {
    try {
      let snapshot: PluginManifestSnapshot | null = null;

      try {
        snapshot = await this.manifestStore.getById(context.pluginId);
      } catch (storeError) {
        const decision: ManifestEnforcementDecision = {
          status: 'deny',
          reason: 'manifest_store_error',
          errorMessage: storeError instanceof Error ? storeError.message : String(storeError),
        };
        this.recordPolicyMetrics(decision, context.pluginId);
        return decision;
      }

      if (!snapshot) {
        const decision: ManifestEnforcementDecision = {
          status: 'deny',
          reason: 'manifest_not_found',
        };
        this.recordPolicyMetrics(decision, context.pluginId);
        return decision;
      }

      if (
        snapshot.id.name !== context.pluginId.name ||
        snapshot.id.version !== context.pluginId.version
      ) {
        const decision: ManifestEnforcementDecision = {
          status: 'deny',
          reason: 'identity_mismatch',
          manifest: snapshot,
        };
        this.recordPolicyMetrics(decision, context.pluginId);
        return decision;
      }

      const trustDecision = this.evaluateTrust(snapshot);
      if (trustDecision) {
        this.recordPolicyMetrics(trustDecision, context.pluginId);
        return trustDecision;
      }

      const decision: ManifestEnforcementDecision = {
        status: 'allow',
        reason: 'ok',
        manifest: snapshot,
      };
      this.recordPolicyMetrics(decision, context.pluginId);
      return decision;
    } catch (err) {
      const decision: ManifestEnforcementDecision = {
        status: 'deny',
        reason: 'internal_error',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
      this.recordPolicyMetrics(decision, context.pluginId);
      return decision;
    }
  }

  private evaluateTrust(snapshot: PluginManifestSnapshot): ManifestEnforcementDecision | null {
    const raw = snapshot.raw as ManifestRaw | undefined;
    if (!raw || !raw.trust) {
      return null;
    }

    const trust = raw.trust;
    const capabilities = raw.capabilities;
 
    const tier =
      typeof trust.tier === 'string' && trust.tier.trim().length > 0
        ? trust.tier.trim().toLowerCase()
        : undefined;
    const riskLevel =
      typeof trust.risk_level === 'string' && trust.risk_level.trim().length > 0
        ? trust.risk_level.trim().toLowerCase()
        : undefined;
 
    const network = capabilities?.network;
    const filesystem = capabilities?.filesystem;
 
    const egressAllow = Array.isArray(network?.egress_allow)
      ? (network.egress_allow as unknown[])
      : [];
    const fsWrite = Array.isArray(filesystem?.write)
      ? (filesystem.write as unknown[])
      : [];
    const secrets = Array.isArray(capabilities?.secrets)
      ? (capabilities.secrets as unknown[])
      : [];
    const envAllow = Array.isArray(capabilities?.env_allow)
      ? (capabilities.env_allow as unknown[])
      : [];
 
    const hasNetworkEgress = egressAllow.length > 0;
    const hasFsWrite = fsWrite.length > 0;
    const hasSecrets = secrets.length > 0;
    const hasEnvAllow = envAllow.length > 0;
 
    const hasSensitiveCapabilities =
      hasNetworkEgress || hasFsWrite || hasSecrets || hasEnvAllow;

    const highRiskTier = tier === 'high_risk';
    const criticalRisk = riskLevel === 'critical';
    const untrustedTier = !tier || tier === 'unverified';

    if (highRiskTier || criticalRisk || (hasSensitiveCapabilities && untrustedTier)) {
      const details: string[] = [];
      if (tier) details.push(`tier=${tier}`);
      if (riskLevel) details.push(`risk_level=${riskLevel}`);
      if (hasSensitiveCapabilities) details.push('sensitive_capabilities=true');

      const errorMessage =
        details.length > 0
          ? `trust policy violation (${details.join(', ')})`
          : 'trust policy violation';

      return {
        status: 'deny',
        reason: 'trust_policy_violation',
        manifest: snapshot,
        errorMessage,
      };
    }

    return null;
  }

  private recordPolicyMetrics(
    decision: ManifestEnforcementDecision,
    pluginId: PluginManifestId,
  ): void {
    try {
      const resource = `plugin.${pluginId.name}`;
      manifestPolicyEvaluations.inc({
        status: decision.status,
        source: MANIFEST_POLICY_SOURCE,
        resource,
      });
      if (decision.status === 'deny') {
        manifestPolicyDenials.inc({
          reason: decision.reason,
          severity: this.mapSeverity(decision.reason),
          source: MANIFEST_POLICY_SOURCE,
        });
      }
    } catch {
      // Policy metrics must never break manifest enforcement.
    }
  }

  private mapSeverity(reason: ManifestEnforcementReason): 'critical' | 'warning' | 'info' {
    if (
      reason === 'internal_error' ||
      reason === 'manifest_store_error' ||
      reason === 'trust_policy_violation'
    ) {
      return 'critical';
    }
    if (reason === 'manifest_not_found' || reason === 'identity_mismatch') {
      return 'warning';
    }
    return 'info';
  }
}