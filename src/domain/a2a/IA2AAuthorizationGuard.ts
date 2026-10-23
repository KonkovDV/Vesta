/**
 * IA2AAuthorizationGuard — Domain port for A2A/MCP request authorization
 * Layer: Domain (port / contract)
 *
 * Defines the contract for authorizing inbound Agent-to-Agent and MCP
 * protocol requests. This guard validates Bearer tokens (OAuth 2.1 /
 * Streamable HTTP) and determines whether a remote agent is permitted
 * to invoke local skills or tools.
 *
 * The guard prepares MicroPhoenix for federation through the Linux
 * Foundation `agentgateway` proxy layer by enforcing token-based auth
 * on all A2A/MCP endpoints before they become externally reachable.
 *
 * Implementation resides in Infrastructure; resolution via DI only:
 *   container.resolve<IA2AAuthorizationGuard>(DI_TOKENS.IA2AAuthorizationGuard)
 *
 * @Horizon 2 — Federation & Intelligence (Security)
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-12 — OAuth 2.1
 * @see https://agentgateway.dev — Linux Foundation AgentGateway
 * @see src/application/middleware/auth.ts — existing HTTP auth middleware
 */

// ─── Value Types ──────────────────────────────────────────────────────

/**
 * PKCE challenge pair for OAuth 2.1 compliance (RFC 7636, OAuth 2.1 §4.1).
 *
 * OAuth 2.1 mandates PKCE for ALL authorization code flows, including
 * server-side clients. Implicit Grant and ROPC are deprecated.
 *
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-12#section-4.1
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 */
export interface PKCEChallenge {
  /** Random verifier string, 43–128 chars, charset: [A-Z][a-z][0-9]-._~ */
  readonly code_verifier: string;
  /** SHA-256 hash of code_verifier, Base64URL encoded */
  readonly code_challenge: string;
  /** Only 'S256' allowed per OAuth 2.1 (plain is deprecated) */
  readonly code_challenge_method: 'S256';
}

/** Result of an A2A authorization evaluation */
export interface A2AAuthResult {
  /** Whether the request is authorized */
  readonly authorized: boolean;
  /** Authenticated agent identity (set when authorized === true) */
  readonly agentId?: string;
  /** Scopes/permissions granted to the agent */
  readonly scopes?: readonly string[];
  /** Reason for denial (set when authorized === false) */
  readonly denyReason?: string;
  /** HTTP status code to return on denial (401 or 403) */
  readonly statusCode?: number;
}

/** Token claims extracted from a validated Bearer token */
export interface A2ATokenClaims {
  /** Subject — the remote agent identifier */
  readonly sub: string;
  /** Issuer — the token issuer (IdP / agentgateway) */
  readonly iss: string;
  /** Audience — must include this instance's agentId */
  readonly aud: string | readonly string[];
  /** Expiration time (Unix timestamp) */
  readonly exp: number;
  /** Issued-at time (Unix timestamp) */
  readonly iat: number;
  /** Scopes granted to the agent */
  readonly scope?: string;
  /** A2A protocol version qualifier */
  readonly a2a_version?: string;
}

/** Configuration for the authorization guard */
export interface A2AGuardConfig {
  /** Guard operating mode */
  readonly mode: 'enforce' | 'audit' | 'disabled';
  /** Allowed agent IDs (allowlist). Empty = allow all authenticated agents */
  readonly allowedAgentIds?: readonly string[];
  /** Required scopes for tool invocation (e.g., ['a2a:invoke', 'mcp:tools']) */
  readonly requiredScopes?: readonly string[];
  /** Expected audience value for token validation */
  readonly expectedAudience?: string;
  /** Expected issuer (IdP). In enforce mode an empty value rejects the token (RFC 9068). */
  readonly expectedIssuer?: string;
}

// ─── Port Interface ───────────────────────────────────────────────────

/**
 * Port for authorizing A2A/MCP inbound requests.
 *
 * Domain/Application layers consume this interface; concrete adapter lives
 * in Infrastructure and is registered via DI token `IA2AAuthorizationGuard`.
 *
 * Modes:
 * - `enforce`: Reject unauthorized requests with 401/403
 * - `audit`: Log unauthorized requests but allow them (migration mode)
 * - `disabled`: Skip authorization entirely (development)
 */
export interface IA2AAuthorizationGuard {
  /**
   * Evaluate an inbound request for authorization.
   *
   * @param bearerToken — raw Bearer token from Authorization header (without 'Bearer ' prefix)
   * @param correlationId — optional correlation ID for observability
   * @returns Authorization result
   */
  evaluate(bearerToken: string | undefined, correlationId?: string): Promise<A2AAuthResult>;

  /**
   * Current guard operating mode.
   */
  getMode(): A2AGuardConfig['mode'];

  /**
   * Generate PKCE challenge pair for authorization code flow.
   *
   * Creates a cryptographically random code_verifier (43–128 chars)
   * and derives the code_challenge via SHA-256 + Base64URL encoding.
   * Only S256 method is supported per OAuth 2.1.
   *
   * NOTE: Sync for current SHA-256 implementation. If a future PQC migration
   * (FIPS 203/204/205, ML-KEM/ML-DSA) replaces the hash primitive with an
   * async-only algorithm, this signature should become `Promise<PKCEChallenge>`.
   *
   * @returns PKCEChallenge with verifier and SHA-256 challenge
   * @see RFC 7636 §4.1 — code_verifier generation
   * @see RFC 7636 §4.2 — code_challenge derivation
   * @see https://csrc.nist.gov/projects/post-quantum-cryptography — NIST PQC
   */
  generatePKCEChallenge(): PKCEChallenge;

  /**
   * Verify PKCE code_verifier against stored code_challenge.
   *
   * Computes SHA256(code_verifier) and compares with the code_challenge
   * from the original authorization request. Uses timing-safe comparison.
   *
   * NOTE: Sync for current SHA-256 implementation. Same PQC migration
   * consideration applies as for `generatePKCEChallenge()`.
   *
   * @param verifier — code_verifier from token exchange request
   * @param challenge — code_challenge from original authorization request
   * @returns true if SHA256(Base64URL(verifier)) === challenge
   */
  verifyPKCE(verifier: string, challenge: string): boolean;
}
