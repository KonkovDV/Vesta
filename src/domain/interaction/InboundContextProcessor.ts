/**
 * Inbound Context Processor Interface
 * Layer: Domain
 * 
 * Responsible for "Sensing" - converting raw external signals (user messages, system events)
 * into cognitive tasks for the Agent.
 */

import { AgentTask } from '../agent-runner/agent-runner.port';

/**
 * Normalized inbound message structure.
 * Represents a signal from the outside world that needs processing.
 */
export interface InboundMessage {
  /** content of the message */
  content: string;
  /** ID of the sender (user or system) */
  senderId: string;
  /** Conversation ID context */
  conversationId: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Contract for processing inbound messages.
 * Acts as the "Senses" of the agent, filtering and converting inputs into thoughts (Tasks).
 */
export interface IInboundContextProcessor {
  /**
   * Process an inbound message and potentially produce an AgentTask.
   * Returns null if the message should be ignored (e.g. self-reflection loop prevention).
   * 
   * @param input The raw inbound message
   * @returns A promise resolving to an AgentTask or null
   */
  process(input: InboundMessage): Promise<AgentTask | null>;
}
