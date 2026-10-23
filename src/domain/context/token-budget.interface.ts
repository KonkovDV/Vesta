
/**
 * Token Budget Interface
 * Types and interfaces for managing LLM context window budget.
 * @layer Domain
 */

import { ConversationContext } from '../context/context-compactor.interface';

export interface TokenBudget {
  /** Total token capacity of the model (e.g. 128000) */
  totalCapacity: number;
  
  /** Total used tokens (including reservations) */
  used: number;
  
  /** Breakdown of reserved tokens */
  reservations: {
    system: number;
    tools: number;
    output: number;
    safety: number;
  };
  
  /** Tokens remaining available for conversation history */
  availableForHistory: number;
}

export interface ITokenBudgetManager {
  /**
   * Calculates the token budget for a given context and model.
   */
  calculateBudget(context: ConversationContext, model?: string): Promise<TokenBudget>;

  /**
   * Checks if a text fits within the remaining budget.
   */
  checkFit(text: string, budget: TokenBudget): boolean;
  
  /**
   * Returns the count of tokens for a given text.
   */
  countTokens(text: string): number;
}
