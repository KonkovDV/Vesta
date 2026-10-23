/**
 * IHardwareEnclaveProvider — Domain port for hardware enclave abstraction.
 *
 * Bridges the gap between simulated TEE signing (HMAC-SHA256) and real hardware
 * enclaves (Intel SGX, AMD SEV-SNP, Azure Confidential Computing). Consumed
 * optionally by AttestedIntentLifecycleAdapter (CC-032) — when no enclave
 * provider is injected, the adapter falls back to simulated HMAC signing.
 *
 * Design Rationale:
 *   - Optional injection: adapters MUST work without hardware enclaves
 *   - Enclave-agnostic: supports SGX, SEV-SNP, ARM TrustZone via EnclaveType union
 *   - Async operations: real TEE signing involves kernel transitions
 *   - Capability reporting: agents can query enclave availability at runtime
 *
 * Integration Points:
 *   - IAttestedIntentLifecycle (CC-032) — primary consumer for intent signing
 *   - ITeeAttestationVerifier (CC-024) — shares attestation semantics
 *
 * Academic Basis:
 *   - RATS Architecture (RFC 9334) — remote attestation procedures
 *   - Taming OpenClaw (arXiv:2603.11619, Mar 2026) — stage 5 execution capability bounding
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-032+ Hardware Enclave Bridge (PUA v5.2 → v5.3 TEE roadmap)
 * @see src/domain/security/IAttestedIntentLifecycle.ts — CC-032 consumer
 * @sota-stub No real enclave implementations exist yet — port defines the contract
 */

// ── Types ──────────────────────────────────────────────────────────

/** Supported hardware enclave types. */
export type EnclaveType = 'simulated' | 'sgx' | 'sev_snp' | 'trustzone';

/** Runtime capabilities of the enclave. */
export interface EnclaveCapabilities {
  /** Enclave type active in this runtime. */
  readonly type: EnclaveType;
  /** Whether the enclave is hardware-backed (vs. simulated). */
  readonly hardwareBacked: boolean;
  /** Maximum payload size for signing (bytes). */
  readonly maxPayloadBytes: number;
  /** Supported signature algorithms. */
  readonly supportedAlgorithms: readonly string[];
  /** Whether remote attestation is available. */
  readonly remoteAttestationAvailable: boolean;
}

/** Result of an enclave signing operation. */
export interface EnclaveSignResult {
  /** Hex-encoded signature. */
  readonly signature: string;
  /** Algorithm used for signing. */
  readonly algorithm: string;
  /** Enclave type that produced the signature. */
  readonly enclaveType: EnclaveType;
  /** Signing timestamp (ISO 8601). */
  readonly signedAt: string;
}

/** Result of an enclave verification operation. */
export interface EnclaveVerifyResult {
  /** Whether the signature is valid. */
  readonly valid: boolean;
  /** Enclave type that verified the signature. */
  readonly enclaveType: EnclaveType;
  /** Verification timestamp (ISO 8601). */
  readonly verifiedAt: string;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Hardware Enclave Provider — abstraction for TEE signing/verification.
 *
 * @sota-stub No hardware implementations yet — this port defines the contract
 *   for future SGX/SNP integration (Q3 2026 roadmap).
 */
export interface IHardwareEnclaveProvider {
  /** Get runtime capabilities of the enclave. */
  getCapabilities(): EnclaveCapabilities;

  /** Sign a payload using the enclave's key material. */
  sign(payload: string): Promise<EnclaveSignResult>;

  /** Verify a signature against a payload. */
  verify(payload: string, signature: string): Promise<EnclaveVerifyResult>;

  /** Check if the enclave is operational. */
  isAvailable(): boolean;
}
