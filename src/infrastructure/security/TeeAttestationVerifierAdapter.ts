/**
 * TeeAttestationVerifierAdapter — Simulated TEE attestation verifier.
 *
 * Stub implementation of ITeeAttestationVerifier. Provides deterministic
 * policy-based threshold checking and simulated attestation verification.
 * Production deployments will integrate with real TEE providers (SGX, Nitro, MAA).
 *
 * @layer Infrastructure (Security)
 * @pattern CC-024 Hardware-Aware Sovereign (PUA Phase 12 → codified)
 * @see src/domain/security/ITeeAttestationVerifier.ts — domain port
 * @see src/core/events/tee-attestation.schemas.ts — Zod validation schemas
 * @sota-stub Simulated attestation — no real TEE integration yet
 */

import type {
  ITeeAttestationVerifier,
  AttestationEvidence,
  TeeAttestationResult,
  AttestationPolicy,
  OperationContext,
} from '../../domain/security/ITeeAttestationVerifier';
import { DEFAULT_ATTESTATION_POLICY } from '../../domain/security/ITeeAttestationVerifier';
import { randomBytes } from 'crypto';

// ── Minimal Logger ────────────────────────────────────────────────

interface AttestationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Adapter ───────────────────────────────────────────────────────

/** @sota-stub Simulated TEE attestation — no real enclave integration */
export class TeeAttestationVerifierAdapter implements ITeeAttestationVerifier {
  private verificationCounter = 0;

  constructor(private readonly logger?: AttestationLogger) {}

  shouldAttest(context: OperationContext, policy?: AttestationPolicy): boolean {
    const p = policy ?? DEFAULT_ATTESTATION_POLICY;

    // Check each policy condition
    if (context.modifiedFiles.length >= p.minFileModifications) {
      this.logger?.info('Attestation required: file modification threshold exceeded', {
        modifiedCount: context.modifiedFiles.length,
        threshold: p.minFileModifications,
      });
      return true;
    }

    if (p.attestBootstrapChanges && context.bootstrapModified) {
      this.logger?.info('Attestation required: bootstrap modified');
      return true;
    }

    if (p.attestSchemaChanges && context.schemaModified) {
      this.logger?.info('Attestation required: schema modified');
      return true;
    }

    if (p.attestNewDomainPorts && context.newDomainPorts) {
      this.logger?.info('Attestation required: new domain ports added');
      return true;
    }

    return false;
  }

  async verifyAttestation(evidence: AttestationEvidence): Promise<TeeAttestationResult> {
    const startMs = Date.now();
    this.verificationCounter++;

    this.logger?.info('Verifying attestation', {
      verificationId: this.verificationCounter,
      provider: evidence.provider,
    });

    // Simulated verification — always succeeds for 'simulated' provider
    const isSimulated = evidence.provider === 'simulated';
    const hasDocument = evidence.document.length > 0;
    const hasNonce = evidence.nonce.length > 0;

    const verificationMs = Date.now() - startMs;

    const result: TeeAttestationResult = {
      valid: isSimulated && hasDocument && hasNonce,
      provider: evidence.provider,
      details: isSimulated
        ? 'Simulated attestation: document and nonce validated (not cryptographically)'
        : `Provider ${evidence.provider} not supported in stub implementation`,
      measurementMatch: isSimulated,
      nonceVerified: hasNonce,
      verificationMs,
      verifiedAt: new Date().toISOString(),
    };

    this.logger?.info('Attestation verification complete', {
      verificationId: this.verificationCounter,
      valid: result.valid,
      provider: evidence.provider,
      verificationMs,
    });

    return result;
  }

  generateNonce(): string {
    return randomBytes(32).toString('hex');
  }
}
