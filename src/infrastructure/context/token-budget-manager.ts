
/**
 * Token Budget Manager
 * implementation of dynamic token budgeting strategy.
 * @layer Infrastructure
 */

import { ITokenBudgetManager, TokenBudget } from '../../domain/context/token-budget.interface';
import { ConversationContext } from '../../domain/context/context-compactor.interface';
import { ITokenizer } from '../../domain/ai/tokenizer.interface';

export type BudgetLevel = 'normal' | 'warning' | 'throttle' | 'emergency';

export interface EnforceLimitResult {
  allowed: boolean;
  level: BudgetLevel;
  suggestedModel?: string;
  maxOutputTokens?: number;
  remainingTokens: number;
}

export class TokenBudgetManager implements ITokenBudgetManager {
  private readonly MODEL_LIMITS: Record<string, number> = {
    'gpt-4': 8192,
    'gpt-4-0613': 8192,
    'gpt-4-32k': 32768,
    'gpt-4-turbo': 128000,
    'gpt-4-turbo-preview': 128000,
    'gpt-3.5-turbo': 16384,
    'gpt-3.5-turbo-16k': 16384,
    // Claude 3.x
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,
    'claude-3.5-opus': 200000,
    'claude-3.5-sonnet': 200000,
    'claude-3.5-haiku': 200000,
    // Claude 4.x
    'claude-4-opus': 200000,
    'claude-4-sonnet': 200000,
    'claude-4.5-opus': 200000,
    'claude-4.5-sonnet': 200000,
    'claude-4.5-haiku': 200000,
    'claude-4.6-opus': 200000,
    'claude-4.6-sonnet': 200000,
    // VS Code aliases
    'claude-opus-4.6': 200000,
    'claude-sonnet-4.6': 200000,
    // Gemini
    'gemini-2.0-pro': 2000000,
    'gemini-2.5-pro': 1000000,
    'gemini-2.0-flash': 1000000,
  };

  private readonly DEFAULT_LIMIT = 4096;
  private readonly SAFETY_MARGIN_PERCENT = 0.02; // 2% buffer

  constructor(private readonly tokenizer: ITokenizer) {}

  async calculateBudget(context: ConversationContext, model = 'gpt-4'): Promise<TokenBudget> {
    const totalCapacity = this.MODEL_LIMITS[model] ?? this.DEFAULT_LIMIT;
    
    // Calculate Reservations
    const systemTokens = context.systemPrompt 
      ? this.tokenizer.countTokens(context.systemPrompt) 
      : 0;

    // Calculate tool definitions tokens if available
    let toolsTokens = 0;
    if (context.metadata?.tools && Array.isArray(context.metadata.tools)) {
      // Rough estimation for JSON schema tokens: ~0.5 tokens per char
      const toolsJson = JSON.stringify(context.metadata.tools);
      toolsTokens = this.tokenizer.countTokens(toolsJson);
    } 
    
    // Output reservation — tiered based on model capacity
    const outputReservation = this.calculateOutputReservation(totalCapacity);
    
    const safetyBuffer = Math.floor(totalCapacity * this.SAFETY_MARGIN_PERCENT);

    const reserved = systemTokens + toolsTokens + outputReservation + safetyBuffer;
    const availableForHistory = Math.max(0, totalCapacity - reserved);

    // Calculate current usage
    let used = systemTokens;
    for (const msg of context.messages) {
      if (msg.content) {
        used += this.tokenizer.countTokens(msg.content);
      }
    }
    
    return {
      totalCapacity,
      used,
      reservations: {
        system: systemTokens,
        tools: toolsTokens,
        output: outputReservation,
        safety: safetyBuffer,
      },
      availableForHistory,
    };
  }

  checkFit(text: string, budget: TokenBudget): boolean {
    const cost = this.tokenizer.countTokens(text);
    return cost <= budget.availableForHistory;
  }

  countTokens(text: string): number {
    return this.tokenizer.countTokens(text);
  }

  getBudgetLevel(budget: TokenBudget): BudgetLevel {
    const usage = budget.used / budget.totalCapacity;
    if (usage >= 0.95) return 'emergency';
    if (usage >= 0.90) return 'throttle';
    if (usage >= 0.80) return 'warning';
    return 'normal';
  }

  enforceLimit(requestedTokens: number, budget: TokenBudget): EnforceLimitResult {
    const level = this.getBudgetLevel(budget);
    const remainingTokens = budget.totalCapacity - budget.used;

    if (level === 'emergency') {
      return { allowed: false, level, maxOutputTokens: 256, remainingTokens };
    }

    if (level === 'throttle') {
      const allowed = requestedTokens <= remainingTokens;
      return {
        allowed,
        level,
        suggestedModel: 'gpt-4o-mini',
        maxOutputTokens: 1_024,
        remainingTokens,
      };
    }

    return { allowed: true, level, remainingTokens };
  }

  private calculateOutputReservation(totalCapacity: number): number {
    if (totalCapacity <= 4096) return Math.floor(totalCapacity * 0.25);
    if (totalCapacity <= 8192) return Math.floor(totalCapacity * 0.20);
    if (totalCapacity <= 16384) return Math.floor(totalCapacity * 0.15);
    if (totalCapacity <= 32768) return Math.floor(totalCapacity * 0.15);
    if (totalCapacity <= 128000) return Math.floor(totalCapacity * 0.12);
    if (totalCapacity <= 200000) return Math.floor(totalCapacity * 0.10);
    return Math.floor(totalCapacity * 0.08);
  }
}
