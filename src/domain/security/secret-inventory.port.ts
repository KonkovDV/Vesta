/**
 * Secret Inventory Domain Port
 *
 * Enumerates rotation targets that are owned by this repository's release
 * process. The first slice is intentionally inventory-first so operators can
 * produce plans and receipts before introducing provider-specific mutation.
 *
 * @layer Domain
 */

export type SecretRotationTargetKind =
  | 'database-credential'
  | 'cache-credential'
  | 'application-secret'
  | 'encryption-key'
  | 'third-party-api-key';

export type SecretRotationProvider = 'env' | 'kubernetes' | 'vault';

export interface SecretRotationTarget {
  readonly id: string;
  readonly kind: SecretRotationTargetKind;
  readonly provider: SecretRotationProvider;
  readonly supportsAutomatedRotation: boolean;
  readonly requiresHumanApproval: boolean;
  readonly description?: string;
}

export interface ISecretInventory {
  listTargets(): Promise<readonly SecretRotationTarget[]>;
  getTargetsByIds(targetIds: readonly string[]): Promise<SecretRotationTarget[]>;
}