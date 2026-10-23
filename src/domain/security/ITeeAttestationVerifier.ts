/**
 * ITeeAttestationVerifier — Domain port for Trusted Execution Environment attestation.
 *
 * CC-024 Hardware-Aware Sovereign: prepares the domain contract for TEE-based
 * execution attestation on high-risk operations. Agent refactorings that touch
 * ≥10 files or modify DI bootstrap should be cryptographically attested via
 * hardware-backed TEEs (teeML concept — Flashbots/Azure, 2024-2026).
 *
 * Architecture:
 *   Agent action → ITeeAttestationVerifier.shouldAttest() → threshold check
 *     → If attested: verifyAttestation() → TeeAttestationResult
 *     → Operations with valid attestation get elevated trust level
 *
 * TEE Providers (roadmap):
 *   - Intel SGX / TDX — via teeML attestation protocol
 *   - AWS Nitro Enclaves — nitro-attestation-document
 *   - Azure Confidential Computing — MAA (Microsoft Azure Attestation)
 *   - Generic — RATS (Remote Attestation Procedures, IETF RFC 9334)
 *
 * Academic Basis:
 *   - teeML (Flashbots, 2024) — ML inference attestation in TEEs
 *   - RATS Architecture (RFC 9334) — Remote Attestation Procedures
 *   - Confidential Computing Consortium (CCC) — industry standardization
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-024 Hardware-Aware Sovereign (PUA Phase 12 → codified)
 * @see 98_PUA_SYSTEM_AUDIT_REPORT.md — H12-04 Hardware-Aware Attestation Roadmap
 * @sota-stub This port is aspirational — current implementations are stubs
 */

// ── Types ──────────────────────────────────────────────────────────

/** TEE provider backend. */
export type TeeProvider = 'sgx' | 'nitro' | 'azure_maa' | 'rats_generic' | 'simulated';

/** Attestation evidence format. */
export interface AttestationEvidence {
  /** Provider that generated the evidence. */
  readonly provider: TeeProvider;
  /** Raw attestation document (base64-encoded). */
  readonly document: string;
  /** Nonce used to prevent replay attacks. */
  readonly nonce: string;
  /** Timestamp of attestation. */
  readonly attestedAt: string;
  /** Enclave measurement / hash (provider-specific). */
  readonly measurement?: string;
}

/** Result of attestation verification. */
export interface TeeAttestationResult {
  /** Whether attestation is valid. */
  readonly valid: boolean;
  /** Provider used. */
  readonly provider: TeeProvider;
  /** Verification details or failure reason. */
  readonly details: string;
  /** Whether the enclave measurement matches expected value. */
  readonly measurementMatch: boolean;
  /** Nonce matches the one provided in the request. */
  readonly nonceVerified: boolean;
  /** Verification duration in milliseconds. */
  readonly verificationMs: number;
  /** Timestamp of verification. */
  readonly verifiedAt: string;
}

/** Policy for determining when attestation is required. */
export interface AttestationPolicy {
  /** Minimum number of file modifications to trigger attestation. */
  readonly minFileModifications: number;
  /** Whether DI bootstrap changes always require attestation. */
  readonly attestBootstrapChanges: boolean;
  /** Whether event schema changes require attestation. */
  readonly attestSchemaChanges: boolean;
  /** Whether to require attestation for domain port additions. */
  readonly attestNewDomainPorts: boolean;
}

/** Default attestation policy aligned with PUA Phase 12 thresholds. */
export const DEFAULT_ATTESTATION_POLICY: AttestationPolicy = {
  minFileModifications: 10,
  attestBootstrapChanges: true,
  attestSchemaChanges: true,
  attestNewDomainPorts: true,
};

/** An operation context used for attestation threshold checking. */
export interface OperationContext {
  /** Description of the operation. */
  readonly description: string;
  /** Files modified by the operation. */
  readonly modifiedFiles: readonly string[];
  /** Whether DI bootstrap was changed. */
  readonly bootstrapModified: boolean;
  /** Whether event schemas were changed. */
  readonly schemaModified: boolean;
  /** Whether new domain ports were added. */
  readonly newDomainPorts: boolean;
  /** PUA level at the time of operation (if applicable). */
  readonly puaLevel?: number;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * TEE Attestation Verifier — hardware-backed attestation for high-risk operations.
 *
 * Provides the domain contract for verifying that agent operations execute
 * within a trusted execution environment. Current implementations use
 * simulated attestation; production deployments will integrate with
 * real TEE providers (SGX, Nitro, Azure MAA).
 *
 * @sota-stub Current implementation is simulated — no real TEE integration yet
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface ITeeAttestationVerifier {
  /**
   * Check whether an operation requires TEE attestation based on policy.
   *
   * @param context - The operation context
   * @param policy - Attestation policy (defaults to DEFAULT_ATTESTATION_POLICY)
   * @returns Whether attestation should be requested
   */
  shouldAttest(context: OperationContext, policy?: AttestationPolicy): boolean;

  /**
   * Verify attestation evidence.
   *
   * @param evidence - The attestation evidence to verify
   * @returns Verification result
   */
  verifyAttestation(evidence: AttestationEvidence): Promise<TeeAttestationResult>;

  /**
   * Generate a fresh nonce for attestation challenge-response.
   *
   * @returns A cryptographically random nonce string
   */
  generateNonce(): string;
}
