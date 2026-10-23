/**
 * AttestedIntentLifecycleAdapter — In-memory TEE-signed intent lifecycle.
 *
 * @layer Infrastructure (Security)
 * @pattern CC-032 Attested Intent Lifecycle (PUA v5.2 → TEE 2.0)
 * @see src/domain/security/IAttestedIntentLifecycle.ts — domain port
 * @sota-stub TEE signing is simulated via HMAC — production requires real TEE
 */

import { createHmac } from 'crypto';
import type {
  IAttestedIntentLifecycle,
  IntentStatus,
  WriteOperation,
  AttestableIntent,
  WriteAccessVerdict,
  IntentLifecycleConfig,
  IntentLifecycleStats,
} from '../../domain/security/IAttestedIntentLifecycle';
import { DEFAULT_INTENT_LIFECYCLE_CONFIG } from '../../domain/security/IAttestedIntentLifecycle';
import type { EnclaveType } from '../../domain/security/IHardwareEnclaveProvider';

// ── Logger ────────────────────────────────────────────────────────

interface IntentLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Internal Intent State ─────────────────────────────────────────

interface MutableIntent {
  intentId: string;
  description: string;
  targetFiles: readonly string[];
  permittedOperations: readonly WriteOperation[];
  status: IntentStatus;
  signature?: string;
  signedAt?: string;
  expiresAt: string;
  registeredAt: string;
  enclaveType?: EnclaveType;
}

// ── Adapter ───────────────────────────────────────────────────────

/** @sota-stub TEE signing simulated via HMAC-SHA256 */
export class AttestedIntentLifecycleAdapter implements IAttestedIntentLifecycle {
  private readonly intents = new Map<string, MutableIntent>();
  private intentCounter = 0;
  private totalRegistered = 0;
  private totalSigned = 0;
  private totalVerifications = 0;
  private grantsCount = 0;
  private denialsCount = 0;
  private revocationsCount = 0;

  /** @sota-stub Simulated signing key — production: TEE-derived key */
  private readonly signingKey = 'pua-v52-simulated-tee-key';

  constructor(private readonly logger?: IntentLogger) {}

  registerIntent(
    description: string,
    targetFiles: readonly string[],
    operations: readonly WriteOperation[],
    config: IntentLifecycleConfig = DEFAULT_INTENT_LIFECYCLE_CONFIG,
  ): AttestableIntent {
    this.intentCounter++;
    const intentId = `intent-${Date.now()}-${this.intentCounter}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.defaultExpirationMinutes * 60_000);

    const intent: MutableIntent = {
      intentId,
      description,
      targetFiles,
      permittedOperations: operations,
      status: 'registered',
      expiresAt: expiresAt.toISOString(),
      registeredAt: now.toISOString(),
    };

    this.intents.set(intentId, intent);
    this.totalRegistered++;

    this.logger?.info('Intent registered', { intentId, targetFiles: targetFiles.length, operations: operations.length });

    return this.toImmutable(intent);
  }

  signIntent(intentId: string): AttestableIntent | null {
    const intent = this.intents.get(intentId);
    if (!intent) return null;
    if (intent.status !== 'registered') return null;

    /** @sota-stub HMAC-SHA256 simulates TEE signing */
    const payload = `${intent.intentId}:${intent.description}:${intent.targetFiles.join(',')}:${intent.permittedOperations.join(',')}`;
    const signature = createHmac('sha256', this.signingKey).update(payload).digest('hex');

    intent.status = 'signed';
    intent.signature = signature;
    intent.signedAt = new Date().toISOString();
    this.totalSigned++;

    this.logger?.info('Intent signed', { intentId, signature: signature.slice(0, 16) + '...' });

    return this.toImmutable(intent);
  }

  verifyWriteAccess(filePath: string, operation: WriteOperation): WriteAccessVerdict {
    this.totalVerifications++;
    const normalized = filePath.replace(/\\/g, '/');
    const now = new Date();

    // Find a matching signed intent
    for (const intent of this.intents.values()) {
      // Skip non-signed/expired/revoked
      if (intent.status !== 'signed' && intent.status !== 'active') continue;
      if (new Date(intent.expiresAt) < now) {
        intent.status = 'expired';
        continue;
      }

      // Check file scope
      const fileInScope = intent.targetFiles.some(tf => {
        const normalizedTarget = tf.replace(/\\/g, '/');
        return normalized === normalizedTarget || normalized.endsWith(normalizedTarget);
      });

      if (!fileInScope) continue;

      // Check operation
      const operationPermitted = intent.permittedOperations.includes(operation);
      if (!operationPermitted) continue;

      // Verify signature
      const signatureValid = this.verifySignature(intent);

      if (signatureValid) {
        // Mark as active on first successful verification
        if (intent.status === 'signed') intent.status = 'active';
        this.grantsCount++;
        return {
          granted: true,
          intentId: intent.intentId,
          reason: `Write granted under intent "${intent.description}"`,
          signatureValid: true,
          fileInScope: true,
          operationPermitted: true,
          verifiedAt: now.toISOString(),
        };
      }

      // Tampered signature
      this.denialsCount++;
      this.logger?.warn('Tampered signature detected', { intentId: intent.intentId });
      return {
        granted: false,
        intentId: intent.intentId,
        reason: 'Signature verification failed — possible tampering',
        signatureValid: false,
        fileInScope: true,
        operationPermitted: true,
        verifiedAt: now.toISOString(),
      };
    }

    // No matching intent found
    this.denialsCount++;
    return {
      granted: false,
      reason: `No valid signed intent covers file "${normalized}" with operation "${operation}"`,
      signatureValid: false,
      fileInScope: false,
      operationPermitted: false,
      verifiedAt: now.toISOString(),
    };
  }

  revokeIntent(intentId: string, reason: string): boolean {
    const intent = this.intents.get(intentId);
    if (!intent) return false;
    if (intent.status === 'revoked' || intent.status === 'expired') return false;

    intent.status = 'revoked';
    this.revocationsCount++;

    this.logger?.warn('Intent revoked', { intentId, reason });

    return true;
  }

  getActiveIntents(): readonly AttestableIntent[] {
    const now = new Date();
    const active: AttestableIntent[] = [];

    for (const intent of this.intents.values()) {
      if (intent.status === 'expired' || intent.status === 'revoked') continue;
      if (new Date(intent.expiresAt) < now) {
        intent.status = 'expired';
        continue;
      }
      if (intent.status === 'signed' || intent.status === 'active') {
        active.push(this.toImmutable(intent));
      }
    }

    return active;
  }

  getStats(): IntentLifecycleStats {
    return {
      totalRegistered: this.totalRegistered,
      totalSigned: this.totalSigned,
      totalVerifications: this.totalVerifications,
      grantsCount: this.grantsCount,
      denialsCount: this.denialsCount,
      revocationsCount: this.revocationsCount,
      enclaveType: 'simulated',
    };
  }

  reset(): void {
    this.intents.clear();
    this.intentCounter = 0;
    this.totalRegistered = 0;
    this.totalSigned = 0;
    this.totalVerifications = 0;
    this.grantsCount = 0;
    this.denialsCount = 0;
    this.revocationsCount = 0;
    this.logger?.info('Attested Intent Lifecycle reset');
  }

  // ── Private Helpers ─────────────────────────────────────────

  /** @sota-stub Verify HMAC signature — production: TEE verification */
  private verifySignature(intent: MutableIntent): boolean {
    if (!intent.signature) return false;
    const payload = `${intent.intentId}:${intent.description}:${intent.targetFiles.join(',')}:${intent.permittedOperations.join(',')}`;
    const expected = createHmac('sha256', this.signingKey).update(payload).digest('hex');
    return intent.signature === expected;
  }

  private toImmutable(intent: MutableIntent): AttestableIntent {
    return {
      intentId: intent.intentId,
      description: intent.description,
      targetFiles: intent.targetFiles,
      permittedOperations: intent.permittedOperations,
      status: intent.status,
      signature: intent.signature,
      signedAt: intent.signedAt,
      expiresAt: intent.expiresAt,
      registeredAt: intent.registeredAt,
      enclaveType: intent.enclaveType ?? 'simulated',
    };
  }
}
