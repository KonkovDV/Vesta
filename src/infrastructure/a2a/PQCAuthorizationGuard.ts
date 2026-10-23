/**
 * PQCAuthorizationGuard — Post-Quantum A2A Federation Guard.
 *
 * Layer: Infrastructure (adapter)
 *
 * Wraps / replaces the classical A2AAuthorizationGuard for environments
 * that require NIST Post-Quantum Cryptography (PQC) for federation tokens.
 *
 * Operating modes:
 *   - `enforce`: Rejects non-PQC-signed federation manifests outright
 *     (production, "strict mode" per §8.1).
 *   - `audit`: Logs non-PQC manifests but permits them (migration period).
 *   - `disabled`: Bypasses PQC verification entirely (development).
 *
 * Algorithms:
 *   - ML-DSA (FIPS 204) for signing /.well-known/agent.json manifests.
 *   - ML-KEM (FIPS 203) for establishing secure A2A channels.
 *   - SLH-DSA (FIPS 205) and HQC as crypto-agile backups.
 *
 * @Horizon 4 — Post-Quantum Federation (Phase 8)
 * @see src/domain/security/pq-crypto.interface.ts — PQC port
 * @see src/domain/a2a/IA2AAuthorizationGuard.ts — classical guard port
 * @see 61_PHASE_8_SINGULARITY_AUDITOR.md §8.1
 */

import type {
  IPqcCryptoProvider,
  PqcFederationManifest,
  SignatureAlgorithm,
  KemAlgorithm,
} from '../../domain/security/pq-crypto.interface';
import type {
  IA2AAuthorizationGuard,
  A2AAuthResult,
  A2AGuardConfig,
  PKCEChallenge,
} from '../../domain/a2a/IA2AAuthorizationGuard';
import type { CorrelationId } from '../../core/types/branded';

// ── Configuration ────────────────────────────────────────────────────

/** PQC-specific guard config extending base A2A guard config. */
export interface PQCGuardConfig extends A2AGuardConfig {
  /** Preferred ML-DSA variant for signing manifests */
  readonly preferredSignatureAlgorithm?: SignatureAlgorithm;
  /** Preferred ML-KEM variant for federation handshake */
  readonly preferredKemAlgorithm?: KemAlgorithm;
  /** When true, reject manifests signed with classical (non-PQC) algorithms */
  readonly rejectClassicalSignatures?: boolean;
  /** Maximum manifest age in seconds (default: 86400 = 24h) */
  readonly maxManifestAgeSeconds?: number;
}

/** Minimal structured logger interface (subset of IStructuredLogger). */
interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── Result type for PQC manifest evaluation ──────────────────────────

/** Extended result including PQC-specific metadata. */
export interface PQCAuthResult extends A2AAuthResult {
  /** Algorithm used for manifest signature (if PQC-verified) */
  readonly signatureAlgorithm?: SignatureAlgorithm;
  /** Whether the manifest was signed with a PQC algorithm */
  readonly isPqcSigned?: boolean;
  /** KEM algorithm negotiated for the channel (if applicable) */
  readonly negotiatedKem?: KemAlgorithm;
}

// ── Guard Implementation ─────────────────────────────────────────────

/**
 * PQCAuthorizationGuard — verifies PQC-signed federation manifests
 * for A2A agent-to-agent communication.
 *
 * Decorates the classical A2AAuthorizationGuard by adding PQC manifest
 * verification as a pre-check. If a PQC manifest is present and valid,
 * the guard issues authorization directly. If not, it delegates to the
 * classical guard (in audit mode) or rejects (in enforce mode).
 *
 * @example
 * const pqcGuard = new PQCAuthorizationGuard(
 *   pqcCryptoProvider,
 *   classicalGuard,
 *   { mode: 'enforce', rejectClassicalSignatures: true },
 *   logger,
 * );
 * const result = await pqcGuard.evaluate(bearerToken, correlationId);
 */
export class PQCAuthorizationGuard implements IA2AAuthorizationGuard {
  private readonly config: Required<PQCGuardConfig>;

  constructor(
    private readonly pqcProvider: IPqcCryptoProvider,
    private readonly classicalGuard: IA2AAuthorizationGuard,
    config: PQCGuardConfig,
    private readonly logger?: ILogger,
  ) {
    this.config = {
      mode: config.mode,
      allowedAgentIds: config.allowedAgentIds ?? [],
      requiredScopes: config.requiredScopes ?? ['a2a:invoke'],
      expectedAudience: config.expectedAudience ?? 'microphoenix',
      expectedIssuer: config.expectedIssuer ?? '',
      preferredSignatureAlgorithm: config.preferredSignatureAlgorithm ?? 'ML-DSA-65',
      preferredKemAlgorithm: config.preferredKemAlgorithm ?? 'ML-KEM-768',
      rejectClassicalSignatures: config.rejectClassicalSignatures ?? true,
      maxManifestAgeSeconds: config.maxManifestAgeSeconds ?? 86_400,
    };
  }

  /**
   * Evaluate an incoming bearer token OR PQC-signed manifest.
   *
   * Decision logic:
   *   1. If mode=disabled → pass immediately
   *   2. Try to parse as PQC federation manifest (JSON with `.signature`)
   *   3. If PQC manifest found → verify signature + expiry
   *   4. If classical token → delegate to classical guard OR reject in strict mode
   */
  async evaluate(
    bearerToken: string | undefined,
    correlationId?: string,
  ): Promise<PQCAuthResult> {
    // ── Disabled mode ────────────────────────────────────────────────
    if (this.config.mode === 'disabled') {
      return { authorized: true, agentId: 'anonymous', scopes: [] };
    }

    // ── No token ─────────────────────────────────────────────────────
    if (!bearerToken || bearerToken.trim().length === 0) {
      const result: PQCAuthResult = {
        authorized: false,
        denyReason: 'Missing Bearer token or PQC manifest in Authorization header',
        statusCode: 401,
      };
      return this.applyMode(result, correlationId);
    }

    // ── Try PQC manifest parse ───────────────────────────────────────
    const manifest = this.tryParsePqcManifest(bearerToken);

    if (manifest) {
      return this.evaluatePqcManifest(manifest, correlationId as CorrelationId);
    }

    // ── Classical token path ─────────────────────────────────────────
    if (this.config.rejectClassicalSignatures && this.config.mode === 'enforce') {
      this.logger?.warn('pqc_classical_rejected', {
        reason: 'Non-PQC bearer token rejected in strict PQC enforcement mode',
        correlation_id: correlationId,
      });

      const result: PQCAuthResult = {
        authorized: false,
        denyReason: 'Non-PQC signed token rejected — PQC federation required (strict mode)',
        statusCode: 403,
        isPqcSigned: false,
      };
      return this.applyMode(result, correlationId);
    }

    // ── Delegate to classical guard (audit or non-strict enforce) ────
    this.logger?.info('pqc_classical_fallback', {
      reason: 'Token is not a PQC manifest — delegating to classical A2A guard',
      mode: this.config.mode,
      correlation_id: correlationId,
    });

    const classicalResult = await this.classicalGuard.evaluate(bearerToken, correlationId);
    return {
      ...classicalResult,
      isPqcSigned: false,
    };
  }

  getMode(): A2AGuardConfig['mode'] {
    return this.config.mode;
  }

  generatePKCEChallenge(): PKCEChallenge {
    return this.classicalGuard.generatePKCEChallenge();
  }

  verifyPKCE(verifier: string, challenge: string): boolean {
    return this.classicalGuard.verifyPKCE(verifier, challenge);
  }

  // ── PQC Manifest Evaluation ────────────────────────────────────────

  /**
   * Evaluate a PQC-signed federation manifest.
   *
   * Checks:
   *   1. Signature validity via IPqcCryptoProvider.verifyFederationManifest
   *   2. Manifest expiration
   *   3. Maximum manifest age
   *   4. Payload structure (agent.json must contain expected fields)
   */
  private async evaluatePqcManifest(
    manifest: PqcFederationManifest,
    correlationId: CorrelationId,
  ): Promise<PQCAuthResult> {
    // ── Verify signature ─────────────────────────────────────────────
    let signatureValid: boolean;
    try {
      signatureValid = await this.pqcProvider.verifyFederationManifest(manifest, correlationId);
    } catch (error) {
      const result: PQCAuthResult = {
        authorized: false,
        denyReason: `PQC signature verification error: ${error instanceof Error ? error.message : String(error)}`,
        statusCode: 401,
        isPqcSigned: true,
        signatureAlgorithm: manifest.signature.algorithm,
      };
      return this.applyMode(result, correlationId);
    }

    if (!signatureValid) {
      const result: PQCAuthResult = {
        authorized: false,
        denyReason: 'PQC federation manifest signature invalid',
        statusCode: 403,
        isPqcSigned: true,
        signatureAlgorithm: manifest.signature.algorithm,
      };
      return this.applyMode(result, correlationId);
    }

    // ── Expiration check ─────────────────────────────────────────────
    const now = new Date();
    const expiresAt = new Date(manifest.expiresAt);
    if (expiresAt <= now) {
      const result: PQCAuthResult = {
        authorized: false,
        denyReason: 'PQC federation manifest expired',
        statusCode: 401,
        isPqcSigned: true,
        signatureAlgorithm: manifest.signature.algorithm,
      };
      return this.applyMode(result, correlationId);
    }

    // ── Max age check ────────────────────────────────────────────────
    const issuedAt = new Date(manifest.issuedAt);
    const ageSeconds = (now.getTime() - issuedAt.getTime()) / 1000;
    if (ageSeconds > this.config.maxManifestAgeSeconds) {
      const result: PQCAuthResult = {
        authorized: false,
        denyReason: `PQC manifest too old: ${Math.round(ageSeconds)}s > max ${this.config.maxManifestAgeSeconds}s`,
        statusCode: 401,
        isPqcSigned: true,
        signatureAlgorithm: manifest.signature.algorithm,
      };
      return this.applyMode(result, correlationId);
    }

    // ── Parse agent.json payload ─────────────────────────────────────
    let agentPayload: Record<string, unknown>;
    try {
      agentPayload = JSON.parse(manifest.payload);
    } catch {
      const result: PQCAuthResult = {
        authorized: false,
        denyReason: 'PQC manifest payload is not valid JSON',
        statusCode: 400,
        isPqcSigned: true,
        signatureAlgorithm: manifest.signature.algorithm,
      };
      return this.applyMode(result, correlationId);
    }

    const agentId = (agentPayload['agent_id'] as string) ?? (agentPayload['name'] as string) ?? 'unknown';
    const issuer = typeof agentPayload['iss'] === 'string' ? agentPayload['iss'] : '';

    // ── Agent allowlist ──────────────────────────────────────────────
    if (
      this.config.allowedAgentIds.length > 0 &&
      !this.config.allowedAgentIds.includes(agentId)
    ) {
      const result: PQCAuthResult = {
        authorized: false,
        denyReason: `Agent "${agentId}" not in allowlist`,
        agentId,
        statusCode: 403,
        isPqcSigned: true,
        signatureAlgorithm: manifest.signature.algorithm,
      };
      return this.applyMode(result, correlationId);
    }

    if (this.config.expectedIssuer.length === 0) {
      const result: PQCAuthResult = {
        authorized: false,
        denyReason: 'Token issuer is not configured',
        agentId,
        statusCode: 403,
        isPqcSigned: true,
        signatureAlgorithm: manifest.signature.algorithm,
      };
      return this.applyMode(result, correlationId);
    }
    if (issuer !== this.config.expectedIssuer) {
      const result: PQCAuthResult = {
        authorized: false,
        denyReason: `Token issuer mismatch: expected "${this.config.expectedIssuer}", got "${issuer}"`,
        agentId,
        statusCode: 403,
        isPqcSigned: true,
        signatureAlgorithm: manifest.signature.algorithm,
      };
      return this.applyMode(result, correlationId);
    }
    const rawAudience = agentPayload['aud'];
    const audiences = Array.isArray(rawAudience)
      ? rawAudience.filter((value): value is string => typeof value === 'string')
      : typeof rawAudience === 'string'
        ? [rawAudience]
        : [];
    if (!audiences.includes(this.config.expectedAudience)) {
      const result: PQCAuthResult = {
        authorized: false,
        denyReason: `Token audience mismatch: expected "${this.config.expectedAudience}"`,
        agentId,
        statusCode: 403,
        isPqcSigned: true,
        signatureAlgorithm: manifest.signature.algorithm,
      };
      return this.applyMode(result, correlationId);
    }

    // ── Authorized ───────────────────────────────────────────────────
    this.logger?.info('pqc_auth_granted', {
      agent_id: agentId,
      algorithm: manifest.signature.algorithm,
      kem: manifest.kemAlgorithm,
      correlation_id: correlationId,
    });

    return {
      authorized: true,
      agentId,
      scopes: ['a2a:invoke'],
      isPqcSigned: true,
      signatureAlgorithm: manifest.signature.algorithm,
      negotiatedKem: manifest.kemAlgorithm,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Try to parse a bearer token as a PQC federation manifest (JSON).
   *
   * Returns null if the token is not a valid PQC manifest structure.
   * PQC manifests are base64url-encoded JSON objects with `payload`,
   * `signature`, `issuedAt`, `expiresAt`, and `kemAlgorithm` fields.
   */
  private tryParsePqcManifest(token: string): PqcFederationManifest | null {
    try {
      // First try direct JSON parse
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(token);
      } catch {
        // Try base64url decode
        const decoded = Buffer.from(token, 'base64url').toString('utf-8');
        parsed = JSON.parse(decoded);
      }

      // Validate PQC manifest structure
      if (
        typeof parsed['payload'] === 'string' &&
        parsed['signature'] &&
        typeof (parsed['signature'] as Record<string, unknown>)['algorithm'] === 'string' &&
        typeof parsed['issuedAt'] === 'string' &&
        typeof parsed['expiresAt'] === 'string' &&
        typeof parsed['kemAlgorithm'] === 'string'
      ) {
        return parsed as unknown as PqcFederationManifest;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Apply operating mode (audit vs enforce) to a denial result.
   */
  private applyMode(
    result: PQCAuthResult,
    correlationId?: string | CorrelationId,
  ): PQCAuthResult {
    if (this.config.mode === 'audit') {
      this.logger?.warn('pqc_auth_audit_deny', {
        deny_reason: result.denyReason,
        agent_id: result.agentId,
        is_pqc_signed: result.isPqcSigned,
        correlation_id: correlationId,
        note: 'Audit mode — request permitted despite PQC auth failure',
      });
      return {
        authorized: true,
        agentId: result.agentId ?? 'anonymous',
        scopes: [],
        isPqcSigned: result.isPqcSigned,
        signatureAlgorithm: result.signatureAlgorithm,
      };
    }

    // Enforce mode
    this.logger?.warn('pqc_auth_denied', {
      deny_reason: result.denyReason,
      agent_id: result.agentId,
      status_code: result.statusCode,
      is_pqc_signed: result.isPqcSigned,
      algorithm: result.signatureAlgorithm,
      correlation_id: correlationId,
    });
    return result;
  }
}
