/**
 * PqcEventSigningMiddleware — Infrastructure adapter for PQC event chain signing.
 *
 * Implements IPqcEventChain using IPqcCryptoProvider for cryptographic operations.
 * Each event is signed with ML-DSA or SLH-DSA, and linked to the previous event
 * via SHA-3-256 hash chain (previousPQCHash + chainSequence).
 *
 * @layer Infrastructure
 * @pattern Pillar-4 PQC Provenance (Event Chain Middleware)
 * @see src/domain/events/IPqcEventChain.ts — Domain port
 * @see src/domain/security/pq-crypto.interface.ts — Crypto provider port
 */

import { createHash } from 'node:crypto';
import type {
  IPqcEventChain,
  PqcSignedEventMetadata,
  ChainVerificationResult,
} from '../../domain/events/IPqcEventChain';
import type {
  IPqcCryptoProvider,
  PqcKeyPair,
  SignatureAlgorithm,
} from '../../domain/security/pq-crypto.interface';
import type { CorrelationId } from '../../core/types/branded';

/** Genesis hash — used as previousPQCHash for the first event in a chain. */
const GENESIS_HASH = '0'.repeat(64);

/** Minimal structured logger interface. */
interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export { GENESIS_HASH };

export class PqcEventSigningMiddleware implements IPqcEventChain {
  constructor(
    private readonly cryptoProvider: IPqcCryptoProvider,
    private readonly defaultAlgorithm: SignatureAlgorithm,
    private readonly logger?: MinimalLogger,
  ) {}

  /** Returns the DI-configured default signing algorithm (e.g. ML-DSA-65). */
  getDefaultAlgorithm(): SignatureAlgorithm {
    return this.defaultAlgorithm;
  }

  async signEvent(
    eventPayload: Uint8Array,
    keyPair: PqcKeyPair,
    algorithm: SignatureAlgorithm,
    previousHash: string,
    chainSequence: number,
    correlationId: CorrelationId,
  ): Promise<PqcSignedEventMetadata> {
    // 1. Hash the event payload
    const eventHash = await this.computeEventHash(eventPayload);

    // 2. Build the canonical message: payload + previousHash + sequence
    const chainMessage = this.buildChainMessage(eventPayload, previousHash, chainSequence);

    // 3. Sign with PQC provider
    const pqcSignature = await this.cryptoProvider.sign(
      chainMessage,
      keyPair.secretKey,
      algorithm,
      correlationId,
    );

    // Attach the signer's public key to the signature
    const signatureWithKey = {
      ...pqcSignature,
      signerPublicKey: keyPair.publicKey,
    };

    this.logger?.info('Event signed with PQC', {
      algorithm,
      chainSequence,
      eventHash: eventHash.substring(0, 16) + '...',
      correlationId,
    });

    return {
      pqcSignature: signatureWithKey,
      previousPQCHash: previousHash,
      chainSequence,
      eventHash,
    };
  }

  async verifyChain(
    events: ReadonlyArray<{ readonly payload: Uint8Array; readonly metadata: PqcSignedEventMetadata }>,
    correlationId: CorrelationId,
  ): Promise<ChainVerificationResult> {
    if (events.length === 0) {
      return { valid: true, verifiedCount: 0, totalCount: 0 };
    }

    let expectedPreviousHash = GENESIS_HASH;

    for (let i = 0; i < events.length; i++) {
      const { payload, metadata } = events[i];

      // Check 1: Chain link — previousPQCHash matches expected
      if (metadata.previousPQCHash !== expectedPreviousHash) {
        this.logger?.warn('Chain link broken: previousPQCHash mismatch', {
          chainSequence: metadata.chainSequence,
          expected: expectedPreviousHash.substring(0, 16) + '...',
          actual: metadata.previousPQCHash.substring(0, 16) + '...',
          correlationId,
        });
        return {
          valid: false,
          verifiedCount: i,
          totalCount: events.length,
          firstBrokenLink: metadata.chainSequence,
          error: `Chain link broken at sequence ${metadata.chainSequence}: previousPQCHash mismatch`,
        };
      }

      // Check 2: Chain sequence is monotonically increasing
      if (i > 0 && metadata.chainSequence <= events[i - 1].metadata.chainSequence) {
        return {
          valid: false,
          verifiedCount: i,
          totalCount: events.length,
          firstBrokenLink: metadata.chainSequence,
          error: `Chain sequence not monotonically increasing at ${metadata.chainSequence}`,
        };
      }

      // Check 3: Event hash matches payload
      const computedHash = await this.computeEventHash(payload);
      if (computedHash !== metadata.eventHash) {
        return {
          valid: false,
          verifiedCount: i,
          totalCount: events.length,
          firstBrokenLink: metadata.chainSequence,
          error: `Event hash mismatch at sequence ${metadata.chainSequence}: payload tampered`,
        };
      }

      // Check 4: Signature verification
      const chainMessage = this.buildChainMessage(
        payload,
        metadata.previousPQCHash,
        metadata.chainSequence,
      );
      const signatureValid = await this.cryptoProvider.verify(
        chainMessage,
        metadata.pqcSignature.signature,
        metadata.pqcSignature.signerPublicKey,
        metadata.pqcSignature.algorithm,
        correlationId,
      );

      if (!signatureValid) {
        return {
          valid: false,
          verifiedCount: i,
          totalCount: events.length,
          firstBrokenLink: metadata.chainSequence,
          error: `Signature verification failed at sequence ${metadata.chainSequence}`,
        };
      }

      // Update expected previous hash for next iteration
      expectedPreviousHash = metadata.eventHash;
    }

    this.logger?.info('PQC event chain verified successfully', {
      totalEvents: events.length,
      correlationId,
    });

    return {
      valid: true,
      verifiedCount: events.length,
      totalCount: events.length,
    };
  }

  async computeEventHash(eventPayload: Uint8Array): Promise<string> {
    // Use SHA-3-256 for quantum-resistant hashing
    // Node.js 16+ supports sha3-256 natively
    return createHash('sha3-256').update(eventPayload).digest('hex');
  }

  /**
   * Build the canonical chain message: payload || previousHash || sequence
   * This is what gets signed, ensuring the chain is cryptographically bound.
   */
  private buildChainMessage(
    eventPayload: Uint8Array,
    previousHash: string,
    chainSequence: number,
  ): Uint8Array {
    const hashBytes = Buffer.from(previousHash, 'hex');
    const seqBytes = Buffer.alloc(8);
    seqBytes.writeBigUInt64BE(BigInt(chainSequence));

    const message = Buffer.concat([
      Buffer.from(eventPayload),
      hashBytes,
      seqBytes,
    ]);
    return new Uint8Array(message);
  }
}
