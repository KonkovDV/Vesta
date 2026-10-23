/**
 * IAgentCardProvider — Port interface for A2A Agent Card discovery
 * Layer: Domain (port / contract)
 *
 * Defines the contract for exposing the local agent instance's
 * Agent Card as specified by the A2A Protocol (RC v1.0, Linux Foundation).
 *
 * An Agent Card advertises:
 *   - Identity & version
 *   - Supported skills (capabilities)
 *   - Current SLA commitments (latency, throughput, availability)
 *   - Token metrics (usage, limits, cost)
 *   - Protocol version & supported content types
 *
 * Implementation resides in Infrastructure; resolution via DI only:
 *   container.resolve<IAgentCardProvider>(DI_TOKENS.IAgentCardProvider)
 *
 * @see https://google.github.io/A2A/ — A2A Protocol specification
 * @see [DI_TOKENS](../../core/di/DI_TOKENS.ts) — DI token registry
 */

// ─── Value Types ──────────────────────────────────────────────────────

/** A single skill / capability that this agent advertises */
export interface AgentSkill {
  /** Machine-readable skill identifier (e.g. 'code_review', 'rag_query') */
  readonly id: string;
  /** Human-readable label */
  readonly name: string;
  /** Short description of what the skill does */
  readonly description?: string;
  /** MIME types the skill can accept as input */
  readonly inputModes?: readonly string[];
  /** MIME types the skill can produce as output */
  readonly outputModes?: readonly string[];
}

/** SLA commitments exposed via Agent Card */
export interface AgentSla {
  /** p95 latency in milliseconds for a single turn */
  readonly p95LatencyMs?: number;
  /** Maximum requests per second this agent can sustain */
  readonly maxRps?: number;
  /** Target uptime percentage (0–100) */
  readonly availabilityPercent?: number;
}

/** Token usage / budget metrics */
export interface AgentTokenMetrics {
  /** Total tokens consumed in the current billing period */
  readonly usedTokens?: number;
  /** Hard limit for the current period */
  readonly tokenLimit?: number;
  /** Estimated cost (USD) of consumed tokens */
  readonly estimatedCostUsd?: number;
}

/** Full Agent Card returned by the provider */
export interface AgentCard {
  /** Unique agent instance identifier */
  readonly agentId: string;
  /** Human-readable agent name */
  readonly name: string;
  /** Short description of this agent's purpose */
  readonly description?: string;
  /** Semantic version of the agent */
  readonly version: string;
  /** A2A Protocol version supported (e.g. '1.0') */
  readonly protocolVersion: string;
  /** URL where this Agent Card is served (/.well-known/agent.json) */
  readonly url?: string;
  /** Skills / capabilities advertised by this agent */
  readonly skills: readonly AgentSkill[];
  /** Current SLA commitments */
  readonly sla?: AgentSla;
  /** Token usage metrics */
  readonly tokenMetrics?: AgentTokenMetrics;
  /** Supported input content types */
  readonly supportedInputContentTypes?: readonly string[];
  /** Supported output content types */
  readonly supportedOutputContentTypes?: readonly string[];
  /** ISO timestamp when the card was generated */
  readonly generatedAt: string;
}

// ─── Port Interface ───────────────────────────────────────────────────

/**
 * Port for Agent Card retrieval.
 *
 * Domain/Application layers consume this interface; concrete adapter
 * lives in Infrastructure and is registered via DI token `IAgentCardProvider`.
 */
export interface IAgentCardProvider {
  /**
   * Return the current Agent Card for this instance.
   *
   * Implementations may compute metrics lazily or cache the card
   * with a short TTL (≤ 30 s recommended).
   */
  getAgentCard(): Promise<AgentCard>;
}
