/**
 * SimulatedHardwareEnclaveAdapter — Simulated TEE enclave for development/testing.
 *
 * @layer Infrastructure (Security)
 * @pattern CC-032+ Hardware Enclave Provider (PUA v5.3)
 * @see src/domain/security/IHardwareEnclaveProvider.ts — domain port
 * @sota-stub No real hardware enclave available — production requires SGX/SNP/TrustZone SDK
 */

import { createHmac, randomBytes } from 'crypto';
import type {
  IHardwareEnclaveProvider,
  EnclaveCapabilities,
  EnclaveSignResult,
  EnclaveVerifyResult,
} from '../../domain/security/IHardwareEnclaveProvider';

// ── Logger ────────────────────────────────────────────────────────

interface EnclaveLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Adapter ───────────────────────────────────────────────────────

/** @sota-stub Simulated enclave — HMAC-SHA256 replaces TEE hardware signing */
export class SimulatedHardwareEnclaveAdapter implements IHardwareEnclaveProvider {
  /** @sota-stub Simulated signing key — production: TEE-sealed key */
  private readonly signingKey: string;

  constructor(private readonly logger?: EnclaveLogger) {
    this.signingKey = randomBytes(32).toString('hex');
    this.logger?.info('SimulatedHardwareEnclaveAdapter initialized (no real TEE)');
  }

  getCapabilities(): EnclaveCapabilities {
    return {
      type: 'simulated',
      hardwareBacked: false,
      maxPayloadBytes: 4096,
      supportedAlgorithms: ['hmac-sha256'],
      remoteAttestationAvailable: false,
    };
  }

  /** @sota-stub Signs payload with HMAC-SHA256 — production: TEE hardware key */
  async sign(payload: string): Promise<EnclaveSignResult> {
    const hmac = createHmac('sha256', this.signingKey);
    hmac.update(payload);

    return {
      signature: hmac.digest('hex'),
      algorithm: 'hmac-sha256',
      enclaveType: 'simulated',
      signedAt: new Date().toISOString(),
    };
  }

  /** @sota-stub Verifies HMAC-SHA256 — production: TEE hardware verification */
  async verify(payload: string, signature: string): Promise<EnclaveVerifyResult> {
    const expected = await this.sign(payload);
    const valid = signature === expected.signature;

    return {
      valid,
      enclaveType: 'simulated',
      verifiedAt: new Date().toISOString(),
    };
  }

  isAvailable(): boolean {
    return true; // Simulated enclave is always available
  }
}
