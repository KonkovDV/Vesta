/**
 * IAgentDialogueLoop — Domain Port for Iterative Multi-Agent Dialogue
 *
 * Layer: Domain (port / contract)
 *
 * Iterative multi-agent dialogue loop (MAS pattern).
 * Agents take turns responding until convergence, moderator decision,
 * or max turns limit is reached.
 *
 * Implementation resides in Infrastructure; resolution via DI only:
 *   container.resolve<IAgentDialogueLoop>(DI_TOKENS.IAgentDialogueLoop)
 *
 * @see Book Ch.7 "Multi-Agent Architectures" — Loop Dialogue
 * @see CrewAI-style crew definition (Ch.7)
 */

import type { CorrelationId } from '../../core/types/branded';

// ─── Value Types ──────────────────────────────────────────────────────

/** A participant agent in the dialogue loop */
export interface DialogueParticipant {
  /** Unique identifier for this agent within the dialogue */
  readonly agentId: string;
  /** Role name for this agent (e.g., 'critic', 'proposer', 'moderator') */
  readonly role: string;
  /** System prompt that defines this agent's behavior */
  readonly systemPrompt: string;
}

/** A single turn in the dialogue history */
export interface DialogueTurn {
  /** Sequential turn number (1-based) */
  readonly turnNumber: number;
  /** ID of the agent that produced this turn */
  readonly agentId: string;
  /** The message content produced by the agent */
  readonly message: string;
  /** Epoch timestamp in milliseconds when the turn was produced */
  readonly timestamp: number;
}

/** Configuration for dialogue execution */
export interface DialogueConfig {
  /** Maximum number of turns before forced termination */
  readonly maxTurns: number;
  /**
   * LLM-evaluated termination condition.
   * If provided, after each turn the condition is evaluated;
   * dialogue ends when met (e.g., "All agents agree on a solution").
   */
  readonly terminationCondition?: string;
  /**
   * Agent ID of a moderator that can terminate the dialogue.
   * The moderator runs after each round and decides whether consensus was reached.
   */
  readonly moderatorAgentId?: string;
  /** Optional session ID for persisting turns via ISessionMemoryManager */
  readonly sessionId?: string;
}

/** Reason for dialogue termination */
export type DialogueTerminationReason = 'max_turns' | 'condition_met' | 'moderator';

/** Result of a completed dialogue loop */
export interface DialogueResult {
  /** Complete history of all turns */
  readonly turns: readonly DialogueTurn[];
  /** Total number of turns executed */
  readonly totalTurns: number;
  /** Consensus text if agents converged (optional) */
  readonly consensus?: string;
  /** Reason why the dialogue terminated */
  readonly terminatedBy: DialogueTerminationReason;
  /** Total execution time in milliseconds */
  readonly durationMs: number;
}

// ─── Port Interface ───────────────────────────────────────────────────

/**
 * Port for iterative multi-agent dialogue execution.
 *
 * Domain/Application layers consume this interface; concrete adapter
 * lives in Infrastructure and is registered via DI token `IAgentDialogueLoop`.
 */
export interface IAgentDialogueLoop {
  /**
   * Execute an iterative dialogue loop among the specified participants.
   *
   * Agents take turns in round-robin order. After each round:
   * 1. If terminationCondition is set, evaluate it via LLM
   * 2. If moderatorAgentId is set, ask moderator to assess convergence
   * 3. If maxTurns reached, terminate
   *
   * @throws MaxIterationsExceededError — if maxTurns insufficient and no convergence
   */
  execute(
    participants: readonly DialogueParticipant[],
    initialPrompt: string,
    config: DialogueConfig,
    correlationId: CorrelationId,
  ): Promise<DialogueResult>;
}
