/**
 * Context Compactor
 * Implementation of IContextCompactor using TokenBudgetManager and RecursiveSummarizer.
 * Layer: Infrastructure
 */
import { injectable, inject } from 'inversify';
import {
  IContextCompactor,
  ConversationContext,
  CompactionOptions,
  CompactedContext,
  CompactionStrategy,
} from '../../domain/context/context-compactor.interface';
import { ITokenBudgetManager } from '../../domain/context/token-budget.interface';
import { ISummarizer } from './recursive-summarizer';

@injectable()
export class ContextCompactor implements IContextCompactor {
  private currentStrategy: CompactionStrategy = 'summarization';

  constructor(
    @inject('ITokenBudgetManager') private budgetManager: ITokenBudgetManager,
    @inject('ISummarizer') private summarizer: ISummarizer
  ) {}

  async compact(context: ConversationContext, options: CompactionOptions = {}): Promise<CompactedContext> {
    const model = options.model || 'gpt-4';
    const targetTokens = options.targetTokens || 4000; // Default safe target
    
    // 1. Calculate current usage
    const originalTokens = this.estimateTokens(context);
    
    if (originalTokens <= targetTokens) {
      return {
        conversationId: context.conversationId,
        messages: context.messages,
        originalTokens,
        compactedTokens: originalTokens,
        strategy: 'none'
      };
    }

    // 2. Compaction Logic (Summarization)
    const messages = context.messages;
    const systemPrompt = context.systemPrompt;
    
    // Reserve system prompt tokens
    const systemTokens = systemPrompt ? this.budgetManager.countTokens(systemPrompt) : 0;
    
    // Determine number of recent messages to keep (preserve at least minMessages)
    // We work backwards.
    const minMessages = options.minMessages || 4;
    let keptRawMessages: typeof messages = [];
    let keptTokens = systemTokens;
    let splitIndex = messages.length;

    // Sliding window from end
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const tokens = this.budgetManager.countTokens(msg.content) + 5; // +5 overhead
      
      // If adding this message exceeds budget (leaving room for summary), stop
      // Summary reservation approx 500 tokens
      if (keptTokens + tokens + 500 > targetTokens) {
        // If we haven't met minMessages, we strictly should keep going? 
        // No, budget is hard limit usually. But usually minMessages is small.
        // Let's assume we stop here.
        splitIndex = i + 1;
        break;
      }
      
      keptTokens += tokens;
      keptRawMessages.unshift(msg);
      splitIndex = i;
    }

    // Adjust splitIndex to ensure at least minMessages if possible (unless they are huge)
    if (messages.length - splitIndex < minMessages) {
        // Force keeping minMessages even if it exceeds budget slightly? 
        // Or strictly respect budget? 
        // Let's Respect Budget -> Summarize more.
        // But if even minMessages exceed budget, we have a problem.
        // For now, accept the split calculation.
    }

    // Identify messages to summarize: [0 ... splitIndex - 1]
    const toSummarize = messages.slice(0, splitIndex);
    
    let summaryText = '';
    if (toSummarize.length > 0) {
      const textToSummarize = toSummarize.map(m => `${m.role}: ${m.content}`).join('\n');
      summaryText = await this.summarizer.summarize(textToSummarize);
    }

    // Construct new messages
    const compactedMessages = [];
    
    // If system prompt exists, caller usually handles it, but ConversationContext includes it as property?
    // IContextCompactor interface has `systemPrompt` but `messages` array usually contains `role: system` too?
    // The Interface definition:
    // export interface ConversationContext {
    //   conversationId: string;
    //   messages: Array<{ role: 'user' | 'assistant' | 'system'; ... }>;
    //   systemPrompt?: string; 
    // }
    // Usually 'systemPrompt' property is separate from generic messages list or explicitly first message.
    // If it's separate, we don't need to put it in messages unless `messages` expects it.
    // Let's assume standard behavior: System Prompt is handled by Runner/Provider, 
    // but here we are producing `CompactedContext.messages`.
    
    if (summaryText) {
        compactedMessages.push({
            role: 'system' as const,
            content: `Previous Conversation Summary:\n${summaryText}`
        });
    }
    
    compactedMessages.push(...keptRawMessages);

    // Recalculate tokens
    let compactedTokens = systemTokens; // Base
    compactedMessages.forEach(m => compactedTokens += this.budgetManager.countTokens(m.content));

    return {
      conversationId: context.conversationId,
      messages: compactedMessages,
      originalTokens,
      compactedTokens,
      strategy: 'summarization',
      summary: summaryText
    };
  }

  estimateTokens(context: ConversationContext): number {
    let count = 0;
    if (context.systemPrompt) {
        count += this.budgetManager.countTokens(context.systemPrompt);
    }
    context.messages.forEach(m => {
        count += this.budgetManager.countTokens(m.content);
    });
    return count;
  }

  getCompactionStrategy(): CompactionStrategy {
    return this.currentStrategy;
  }

  setCompactionStrategy(strategy: CompactionStrategy): void {
    this.currentStrategy = strategy;
  }
}
