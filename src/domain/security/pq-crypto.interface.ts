/**
 * IPqcCryptoProvider — Domain port for Post-Quantum Cryptography operations.
 *
 * Abstracts NIST PQC standards (FIPS 203 ML-KEM, FIPS 204 ML-DSA) behind
 * a crypto-agile interface. Infrastructure adapters may swap underlying
 * libraries (liboqs, pqcrypto-wasm, crystals-js) without Domain impact.
 *
 * Motivation: "Harvest Now, Decrypt Later" (HNDL) threat model. Federal
 * mandates (April 2026 US directive) require PQC migration for all
 * government-adjacent systems. A2A federation tokens signed with RSA/ECC
 * are vulnerable to future quantum decryption.
 *
 * Crypto-Agility: The provider interface supports algorithm negotiation —
 * callers request a family (e.g., 'ML-KEM' or 'ML-DSA'), and the provider
 * returns the best available parameter set. This allows seamless transition
 * to backup algorithms (HQC, SLH-DSA) if primary standards are weakened.
 *
 * @layer Domain
 * @pattern Pillar-4 PQC Provenance
 * @FITNESS-K 95.0
 * @see FIPS 203 — ML-KEM (formerly CRYSTALS-Kyber)
 * @see FIPS 204 — ML-DSA (formerly CRYSTALS-Dilithium)
 * @see FIPS 205 — SLH-DSA (formerly SPHINCS+)
 * @see 61_PHASE_8_SINGULARITY_AUDITOR.md §8.1
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Algorithm Families ──────────────────────────────────────────────

/**
 * NIST-standardized Key Encapsulation Mechanism families.
 * ML-KEM (FIPS 203) is the primary; HQC is the backup finalist.
 */
export type KemAlgorithm = 'ML-KEM-512' | 'ML-KEM-768' | 'ML-KEM-1024' | 'HQC-128' | 'HQC-192' | 'HQC-256';

/**
 * NIST-standardized Digital Signature Algorithm families.
 * ML-DSA (FIPS 204) is the primary; SLH-DSA (FIPS 205) is hash-based backup.
 */
export type SignatureAlgorithm =
  | 'ML-DSA-44' | 'ML-DSA-65' | 'ML-DSA-87'
  | 'SLH-DSA-128s' | 'SLH-DSA-128f' | 'SLH-DSA-192s' | 'SLH-DSA-192f' | 'SLH-DSA-256s' | 'SLH-DSA-256f';

// ── Key Material ────────────────────────────────────────────────────

/** PQC key pair — public key + secret (private) key as raw bytes. */
export interface PqcKeyPair {
  /** Algorithm used to generate this key pair */
  readonly algorithm: KemAlgorithm | SignatureAlgorithm;
  /** Public key (DER-encoded or raw, depending on algorithm) */
  readonly publicKey: Uint8Array;
  /** Secret (private) key — MUST be stored via ISecretResolver, never logged */
  readonly secretKey: Uint8Array;
}

/** KEM encapsulation result — ciphertext + shared secret. */
export interface KemEncapsulationResult {
  /** Ciphertext to send to the remote party */
  readonly ciphertext: Uint8Array;
  /** Shared secret (symmetric key material) — derived by both parties */
  readonly sharedSecret: Uint8Array;
}

/** Digital signature over a message. */
export interface PqcSignature {
  /** Algorithm used for signing */
  readonly algorithm: SignatureAlgorithm;
  /** Raw signature bytes */
  readonly signature: Uint8Array;
  /** Public key of the signer (for verification) */
  readonly signerPublicKey: Uint8Array;
}

// ── Signed Federation Manifest ──────────────────────────────────────

/**
 * PQC-signed `/.well-known/agent.json` federation manifest.
 * Replaces JWT-based federation tokens for A2A discovery.
 */
export interface PqcFederationManifest {
  /** The raw agent.json content (canonical JSON, no whitespace) */
  readonly payload: string;
  /** ML-DSA or SLH-DSA signature over the canonical payload */
  readonly signature: PqcSignature;
  /** Manifest creation timestamp (ISO 8601) */
  readonly issuedAt: string;
  /** Manifest expiration timestamp (ISO 8601) */
  readonly expiresAt: string;
  /** Algorithm used for the federation handshake KEM */
  readonly kemAlgorithm: KemAlgorithm;
}

// ── Port Interface ──────────────────────────────────────────────────

/**
 * Post-Quantum Cryptography provider — generates keys, signs, verifies,
 * and performs KEM encapsulation/decapsulation.
 *
 * Designed for crypto-agility: callers specify the algorithm family,
 * and the provider selects the best available parameter set.
 */
export interface IPqcCryptoProvider {
  /**
   * Generate a PQC key pair for the specified algorithm.
   *
   * @param algorithm — the NIST-standardized algorithm to use
   * @param correlationId — tracing ID for audit logging
   * @returns freshly generated key pair
   */
  generateKeyPair(
    algorithm: KemAlgorithm | SignatureAlgorithm,
    correlationId: CorrelationId,
  ): Promise<PqcKeyPair>;

  /**
   * KEM Encapsulate — generate a shared secret + ciphertext using the
   * recipient's public key. Only the recipient can decapsulate.
   *
   * @param recipientPublicKey — the remote agent's ML-KEM public key
   * @param algorithm — KEM algorithm family
   * @param correlationId — tracing ID
   * @returns ciphertext + shared secret
   */
  kemEncapsulate(
    recipientPublicKey: Uint8Array,
    algorithm: KemAlgorithm,
    correlationId: CorrelationId,
  ): Promise<KemEncapsulationResult>;

  /**
   * KEM Decapsulate — recover the shared secret from a ciphertext
   * using our secret key.
   *
   * @param ciphertext — the ciphertext received from the remote agent
   * @param secretKey — our ML-KEM secret key
   * @param algorithm — KEM algorithm family
   * @param correlationId — tracing ID
   * @returns the shared secret (symmetric key material)
   */
  kemDecapsulate(
    ciphertext: Uint8Array,
    secretKey: Uint8Array,
    algorithm: KemAlgorithm,
    correlationId: CorrelationId,
  ): Promise<Uint8Array>;

  /**
   * Sign a message using ML-DSA or SLH-DSA.
   *
   * @param message — the raw bytes to sign
   * @param secretKey — the signing key
   * @param algorithm — signature algorithm
   * @param correlationId — tracing ID
   * @returns the signature object
   */
  sign(
    message: Uint8Array,
    secretKey: Uint8Array,
    algorithm: SignatureAlgorithm,
    correlationId: CorrelationId,
  ): Promise<PqcSignature>;

  /**
   * Verify a signature against a message and public key.
   *
   * @param message — the original message bytes
   * @param signature — the signature to verify
   * @param publicKey — the signer's public key
   * @param algorithm — signature algorithm
   * @param correlationId — tracing ID
   * @returns true if signature is valid
   */
  verify(
    message: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
    algorithm: SignatureAlgorithm,
    correlationId: CorrelationId,
  ): Promise<boolean>;

  /**
   * Sign a federation manifest (/.well-known/agent.json).
   *
   * Canonicalizes the payload, signs with ML-DSA, and returns
   * the complete PqcFederationManifest.
   *
   * @param agentJsonPayload — the agent.json content
   * @param signingKey — our ML-DSA secret key
   * @param signingAlgorithm — signature algorithm
   * @param kemAlgorithm — preferred KEM for federation handshake
   * @param correlationId — tracing ID
   * @returns signed federation manifest
   */
  signFederationManifest(
    agentJsonPayload: Record<string, unknown>,
    signingKey: Uint8Array,
    signingAlgorithm: SignatureAlgorithm,
    kemAlgorithm: KemAlgorithm,
    correlationId: CorrelationId,
  ): Promise<PqcFederationManifest>;

  /**
   * Verify a remote agent's federation manifest signature.
   *
   * @param manifest — the signed manifest to verify
   * @param correlationId — tracing ID
   * @returns true if signature is valid and manifest is not expired
   */
  verifyFederationManifest(
    manifest: PqcFederationManifest,
    correlationId: CorrelationId,
  ): Promise<boolean>;

  /**
   * List supported algorithms for runtime crypto-agility negotiation.
   */
  getSupportedAlgorithms(): {
    readonly kem: readonly KemAlgorithm[];
    readonly signature: readonly SignatureAlgorithm[];
  };
}
