/**
 * AgentDialogueLoopAdapter — Infrastructure Adapter
 *
 * Iterative multi-agent dialogue loop (MAS pattern).
 * Agents take turns responding via LLM until convergence, moderator
 * decision, or max turns limit is reached.
 *
 * Best Practices Applied (March 2026):
 * - Round-robin turn scheduling with full history context per turn
 * - LLM-evaluated termination condition (optional)
 * - Moderator agent pattern (optional) — runs after each round
 * - Atom of Thoughts (NeurIPS 2025): each agent turn is self-contained
 * - Temperature control: agents at 0.7 (creative), condition eval at 0.1 (deterministic)
 *
 * DI: constructor(llmFactory: ILLMAdapterFactory, logger: ILogger) — 2 args
 *
 * @see Book Ch.7 "Multi-Agent Architectures" — Loop Dialogue
 * @see CrewAI-style Crew Definition (Ch.7)
 */

import type { CorrelationId } from '../../core/types/branded';
import type { ILogger } from '../../core/decorators/ILogger';
import type { ILLMAdapter } from '../../domain/ai/ILLMAdapter';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type {
  IAgentDialogueLoop,
  DialogueParticipant,
  DialogueConfig,
  DialogueResult,
  DialogueTurn,
  DialogueTerminationReason,
} from '../../domain/mas/agent-dialogue-loop.interface';

export class AgentDialogueLoopAdapter implements IAgentDialogueLoop {
  /** FIX-S2-09: Max conversation history chars to prevent unbounded memory growth */
  private static readonly MAX_HISTORY_CHARS = 50_000;

  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly logger: ILogger,
  ) {}

  async execute(
    participants: readonly DialogueParticipant[],
    initialPrompt: string,
    config: DialogueConfig,
    correlationId: CorrelationId,
  ): Promise<DialogueResult> {
    const startTime = Date.now();

    this.logger.info('AgentDialogueLoopAdapter.execute', {
      correlationId,
      participantCount: participants.length,
      maxTurns: config.maxTurns,
      hasTerminationCondition: !!config.terminationCondition,
      hasModeratorAgent: !!config.moderatorAgentId,
    });

    if (participants.length === 0) {
      this.logger.warn('AgentDialogueLoopAdapter.emptyParticipants', { correlationId });
      return {
        turns: [],
        totalTurns: 0,
        terminatedBy: 'max_turns',
        durationMs: Date.now() - startTime,
      };
    }

    const { adapter } = await this.llmFactory.createAdapterWithFailover();
    const turns: DialogueTurn[] = [];
    let terminatedBy: DialogueTerminationReason = 'max_turns';
    let consensus: string | undefined;
    let turnNumber = 0;

    // Build initial conversation context
    let conversationHistory = `Initial prompt: ${initialPrompt}\n\n`;

    for (let round = 0; round < config.maxTurns; round++) {
      let roundComplete = false;

      // Each participant takes a turn in this round
      for (const participant of participants) {
        turnNumber++;

        if (turnNumber > config.maxTurns) {
          roundComplete = true;
          break;
        }

        const prompt = this.buildTurnPrompt(
          participant,
          conversationHistory,
          turnNumber,
        );

        this.logger.debug('AgentDialogueLoopAdapter.turn', {
          correlationId,
          turnNumber,
          agentId: participant.agentId,
          role: participant.role,
        });

        const result = await adapter.generateText(prompt, {
          temperature: 0.7,
          maxTokens: 2048,
          systemPrompt: participant.systemPrompt,
        });

        const message = result.text.trim();

        const turn: DialogueTurn = {
          turnNumber,
          agentId: participant.agentId,
          message,
          timestamp: Date.now(),
        };

        turns.push(turn);
        conversationHistory += `[${participant.role} (${participant.agentId}), turn ${turnNumber}]: ${message}\n\n`;

        // FIX-S2-09: Truncate history to prevent LLM context overflow and memory growth
        if (conversationHistory.length > AgentDialogueLoopAdapter.MAX_HISTORY_CHARS) {
          conversationHistory = '...(earlier dialogue truncated)...\n\n' +
            conversationHistory.slice(-AgentDialogueLoopAdapter.MAX_HISTORY_CHARS);
        }
      }

      if (roundComplete) break;

      // After each round, check termination conditions

      // 1. Check moderator if configured
      if (config.moderatorAgentId) {
        const moderatorResult = await this.evaluateModerator(
          adapter,
          config.moderatorAgentId,
          participants,
          conversationHistory,
          correlationId,
        );

        if (moderatorResult.shouldTerminate) {
          terminatedBy = 'moderator';
          consensus = moderatorResult.consensus;

          this.logger.info('AgentDialogueLoopAdapter.moderatorTerminated', {
            correlationId,
            round: round + 1,
            turnNumber,
          });

          break;
        }
      }

      // 2. Check LLM-evaluated termination condition if configured
      if (config.terminationCondition) {
        const conditionMet = await this.evaluateTerminationCondition(
          adapter,
          config.terminationCondition,
          conversationHistory,
          correlationId,
        );

        if (conditionMet) {
          terminatedBy = 'condition_met';

          this.logger.info('AgentDialogueLoopAdapter.conditionMet', {
            correlationId,
            round: round + 1,
            turnNumber,
            condition: config.terminationCondition,
          });

          break;
        }
      }
    }

    const durationMs = Date.now() - startTime;

    this.logger.info('AgentDialogueLoopAdapter.execute.complete', {
      correlationId,
      totalTurns: turns.length,
      terminatedBy,
      durationMs,
      hasConsensus: !!consensus,
    });

    return {
      turns,
      totalTurns: turns.length,
      consensus,
      terminatedBy,
      durationMs,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private buildTurnPrompt(
    participant: DialogueParticipant,
    conversationHistory: string,
    turnNumber: number,
  ): string {
    return [
      `You are "${participant.role}" (agent: ${participant.agentId}).`,
      `This is turn ${turnNumber} of a multi-agent dialogue.`,
      '',
      'Conversation so far:',
      conversationHistory,
      'Now provide your response as this agent. Be concise and constructive.',
    ].join('\n');
  }

  private async evaluateModerator(
    adapter: Pick<ILLMAdapter, 'generateText'>,
    moderatorAgentId: string,
    participants: readonly DialogueParticipant[],
    conversationHistory: string,
    correlationId: CorrelationId,
  ): Promise<{ shouldTerminate: boolean; consensus?: string }> {
    const moderator = participants.find((p) => p.agentId === moderatorAgentId);

    if (!moderator) {
      this.logger.warn('AgentDialogueLoopAdapter.moderatorNotFound', {
        correlationId,
        moderatorAgentId,
      });
      return { shouldTerminate: false };
    }

    const prompt = [
      `You are the moderator of a multi-agent dialogue.`,
      `Review the conversation and determine if consensus has been reached.`,
      '',
      conversationHistory,
      '',
      'Respond with ONLY a JSON object:',
      '{"shouldTerminate": true/false, "consensus": "summary of consensus or null"}',
    ].join('\n');

    this.logger.debug('AgentDialogueLoopAdapter.evaluateModerator', {
      correlationId,
      moderatorAgentId,
    });

    const result = await adapter.generateText(prompt, {
      temperature: 0.1,
      maxTokens: 512,
      systemPrompt: moderator.systemPrompt,
    });

    try {
      const parsed = JSON.parse(result.text.trim());
      return {
        shouldTerminate: !!parsed.shouldTerminate,
        consensus: parsed.consensus ?? undefined,
      };
    } catch {
      // If LLM doesn't return valid JSON, don't terminate
      return { shouldTerminate: false };
    }
  }

  private async evaluateTerminationCondition(
    adapter: Pick<ILLMAdapter, 'generateText'>,
    condition: string,
    conversationHistory: string,
    correlationId: CorrelationId,
  ): Promise<boolean> {
    const prompt = [
      `Evaluate whether the following condition has been met in this conversation:`,
      `Condition: "${condition}"`,
      '',
      conversationHistory,
      '',
      'Answer with ONLY "YES" or "NO".',
    ].join('\n');

    this.logger.debug('AgentDialogueLoopAdapter.evaluateTerminationCondition', {
      correlationId,
      condition,
    });

    const result = await adapter.generateText(prompt, {
      temperature: 0.1,
      maxTokens: 10,
    });

    return result.text.trim().toUpperCase().startsWith('YES');
  }
}
