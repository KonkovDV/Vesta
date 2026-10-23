/**
 * IAttestedIntentLifecycle — Domain port for TEE-signed intent lifecycle management.
 *
 * CC-032 Attested Intent Lifecycle: extends CC-024 (TeeAttestationVerifier) by
 * requiring cryptographic signing of critical "Intents" before write-tool access
 * is granted. Unlike CC-024 which operates at the operation level (post-hoc
 * attestation), CC-032 operates at the intent level (pre-authorization) —
 * each critical intent must be signed before any write operations are permitted.
 *
 * Key Innovation: Intent-Level Write Gating
 *   - Critical intents are registered and signed (simulated signing in current impl)
 *   - Write tools (write_to_file, create_file, replace_string) check for valid signed intent
 *   - Missing or tampered signatures block write access at the domain level
 *   - This prevents prompt injection attacks from gaining unauthorized write access
 *
 * Intent Lifecycle:
 *   1. Agent declares intent → registerIntent()
 *   2. Intent is signed (TEE/simulated) → signIntent()
 *   3. Write tools verify signed intent → verifyWriteAccess()
 *   4. Intent expires or is revoked after task completes → revokeIntent()
 *
 * Integration Points:
 *   - ITeeAttestationVerifier (CC-024) — hardware attestation for intent signing
 *   - IToolExecutionPolicy (CC-012) — write gating integrates with tool firewall
 *   - IIntentMisalignmentDetector (CC-026) — misalignment triggers intent revocation
 *
 * Academic Basis:
 *   - Epistemic Context Learning (arXiv:2601.21742, Jan 2026) — trust calibration
 *   - Epistemic Stability (arXiv:2603.10047, Mar 2026) — stable intent procedures
 *   - Taming OpenClaw (arXiv:2603.11619, Mar 2026) — stage 5 execution capability bounding
 *   - RATS Architecture (RFC 9334) — remote attestation procedures
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-032 Attested Intent Lifecycle (PUA v5.2 → TEE 2.0)
 * @see src/domain/security/ITeeAttestationVerifier.ts — CC-024 base attestation
 * @see src/domain/security/IHardwareEnclaveProvider.ts — CC-032+ enclave bridge
 * @sota-stub TEE signing is simulated — production requires real TEE integration
 */

import type { EnclaveType } from './IHardwareEnclaveProvider';

// ── Types ──────────────────────────────────────────────────────────

/** Intent status in the lifecycle. */
export type IntentStatus = 'registered' | 'signed' | 'active' | 'expired' | 'revoked';

/** Write operation type subject to intent gating. */
export type WriteOperation =
  | 'create_file'
  | 'edit_file'
  | 'delete_file'
  | 'write_config'
  | 'modify_di'
  | 'modify_schema';

/** A registered intent awaiting or holding a signature. */
export interface AttestableIntent {
  /** Unique intent ID. */
  readonly intentId: string;
  /** Description of the intended action. */
  readonly description: string;
  /** Files that may be written under this intent. */
  readonly targetFiles: readonly string[];
  /** Write operations permitted. */
  readonly permittedOperations: readonly WriteOperation[];
  /** Current lifecycle status. */
  readonly status: IntentStatus;
  /** Signature (hex string) — populated after signing. */
  readonly signature?: string;
  /** Signing timestamp. */
  readonly signedAt?: string;
  /** Expiration timestamp. */
  readonly expiresAt: string;
  /** Registration timestamp. */
  readonly registeredAt: string;
  /** Enclave type used for signing (simulated | sgx | sev_snp | trustzone). */
  readonly enclaveType?: EnclaveType;
}

/** Result of a write access verification. */
export interface WriteAccessVerdict {
  /** Whether write access is granted. */
  readonly granted: boolean;
  /** Intent ID used for verification (if any). */
  readonly intentId?: string;
  /** Reason for the verdict. */
  readonly reason: string;
  /** Whether the signature was valid. */
  readonly signatureValid: boolean;
  /** Whether the target file is within the intent's scope. */
  readonly fileInScope: boolean;
  /** Whether the operation type is permitted. */
  readonly operationPermitted: boolean;
  /** Verification timestamp. */
  readonly verifiedAt: string;
}

/** Configuration for intent lifecycle. */
export interface IntentLifecycleConfig {
  /** Default intent expiration in minutes (default: 30). */
  readonly defaultExpirationMinutes: number;
  /** Whether to require signed intents for all writes (default: false — only critical). */
  readonly requireForAllWrites: boolean;
  /** File patterns that always require signed intents. */
  readonly criticalFilePatterns: readonly string[];
  /** Whether misalignment detection triggers automatic revocation (default: true). */
  readonly revokeOnMisalignment: boolean;
}

/** Default configuration. */
export const DEFAULT_INTENT_LIFECYCLE_CONFIG: IntentLifecycleConfig = {
  defaultExpirationMinutes: 30,
  requireForAllWrites: false,
  criticalFilePatterns: [
    'bootstrap.ts', 'orchestrator.ts', 'app.ts', 'index.ts',
    'DI_TOKENS.ts', 'container.ts',
  ],
  revokeOnMisalignment: true,
};

/** Statistics about intent lifecycle management. */
export interface IntentLifecycleStats {
  /** Total intents registered. */
  readonly totalRegistered: number;
  /** Total intents signed. */
  readonly totalSigned: number;
  /** Total write verifications performed. */
  readonly totalVerifications: number;
  /** Write access grants. */
  readonly grantsCount: number;
  /** Write access denials. */
  readonly denialsCount: number;
  /** Intents revoked (by expiration or misalignment). */
  readonly revocationsCount: number;
  /** Enclave type in use ('simulated' | hardware). */
  readonly enclaveType: EnclaveType;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Attested Intent Lifecycle — TEE-signed intent management for write gating.
 *
 * Manages the lifecycle of critical intents that must be cryptographically
 * signed before write operations are permitted on protected files.
 *
 * @sota-stub Signing is currently simulated via HMAC; production requires TEE
 */
export interface IAttestedIntentLifecycle {
  /**
   * Register a new intent for signing.
   *
   * @param description - What the agent intends to do
   * @param targetFiles - Files that will be written
   * @param operations - Write operations that will be performed
   * @param config - Lifecycle configuration
   * @returns The registered (unsigned) intent
   */
  registerIntent(
    description: string,
    targetFiles: readonly string[],
    operations: readonly WriteOperation[],
    config?: IntentLifecycleConfig,
  ): AttestableIntent;

  /**
   * Sign a registered intent (simulated TEE signing).
   *
   * @param intentId - Intent to sign
   * @returns The signed intent, or null if not found/already signed
   */
  signIntent(intentId: string): AttestableIntent | null;

  /**
   * Verify whether a write operation is permitted under a signed intent.
   *
   * @param filePath - File to be written
   * @param operation - Write operation type
   * @returns Write access verdict
   */
  verifyWriteAccess(filePath: string, operation: WriteOperation): WriteAccessVerdict;

  /**
   * Revoke an intent (e.g., due to misalignment detection).
   *
   * @param intentId - Intent to revoke
   * @param reason - Reason for revocation
   * @returns Whether revocation succeeded
   */
  revokeIntent(intentId: string, reason: string): boolean;

  /**
   * Get all active (signed, non-expired) intents.
   *
   * @returns Active intents
   */
  getActiveIntents(): readonly AttestableIntent[];

  /**
   * Get statistics.
   */
  getStats(): IntentLifecycleStats;

  /** Reset all state. */
  reset(): void;
}
