import {
  ChatService,
  type DomainChatCompletionRequest,
  type DomainChatCompletionResult,
  type ChatMessageTimings,
  type ChatMessagePromptProgress,
  type DomainProcessingState,
  type DomainServerProperties,
} from '../../domain/services/ChatService';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type {
  LLMMultimodalGenerateOptions,
  LLMGenerationResult,
} from '../../domain/ai/ILLMAdapter';
import type {
  ApiChatMessageData,
  ApiChatMessageContentPart,
} from '../../protocol/chat';
import type {
  MultimodalChatMessage,
  MultimodalContentPart,
  MultimodalContentType,
} from '../../core/llm/multimodal-types';
import { RequestContext } from '../context/request-context';
import type {
  MultimodalIngestUseCase,
  MultimodalIngestInput,
} from '../memory/multimodal-ingest.usecase';
import type { ILogger } from '../../core/decorators/ILogger';
import {
  getChatMmRequestsCounter,
  getChatMmErrorsCounter,
  getChatMmLatencyHistogram,
} from '../../monitoring';
import { Timestamp } from '../../core/types';
import {
  assembleSystemPrompt,
  createDefaultPromptLayers,
  type PromptBuildContext,
  type PromptLayer,
} from './system-prompt/hermes-prompt-layers';
import type {
  IAdaptiveMemoryRetrieval,
  TipInjectionResult,
} from '../../domain/memory/IAdaptiveMemoryRetrieval';
import type { IContextualTipGenerator } from '../../domain/memory/IContextualTipGenerator';
import type { IHookPipeline } from '../../domain/plugins/hook-pipeline.interface';
import {
  mergeSessionLessonCandidatesIntoTips,
  type SessionLessonCandidate,
} from './session-lesson-tip-overlay';

type ChatRequestWithProtocolShape = DomainChatCompletionRequest & {
  messages?: ApiChatMessageData[];
  temperature?: number;
  max_tokens?: number;
  tipInjection?: TipInjectionResult;
  sessionLessonCandidates?: readonly SessionLessonCandidate[];
  promptContext?: {
    tipInjection?: TipInjectionResult;
    sessionLessonCandidates?: readonly SessionLessonCandidate[];
  };
};

function createEmptyGenerationResult(): LLMGenerationResult {
  return {
    text: '',
    model: 'system',
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    generatedAt: Timestamp.now(),
  };
}

import type { IContextCompactor } from '../../domain/context/context-compactor.interface';
import type { DirectiveParser } from '../interaction/directive-parser';

export class LLMBackedChatService extends ChatService {
  constructor(
    private readonly llmAdapterFactory: ILLMAdapterFactory,
    private readonly multimodalIngestUseCase: MultimodalIngestUseCase,
    private readonly contextCompactor: IContextCompactor,
    private readonly directiveParser: DirectiveParser,
    private readonly logger?: ILogger,
    private readonly adaptiveMemoryRetrieval?: IAdaptiveMemoryRetrieval,
    private readonly tipGenerator?: IContextualTipGenerator,
    private readonly hookPipeline?: IHookPipeline,
  ) {
    super();
  }

  async getServerProperties(): Promise<DomainServerProperties> {
    const base = await super.getServerProperties();
    return {
      ...base,
      capabilities: {
        ...base.capabilities,
        multimodal: true,
      },
    };
  }

  async getProcessingState(
    conversationId: string,
    userId: string,
  ): Promise<DomainProcessingState> {
    return super.getProcessingState(conversationId, userId);
  }

  async generateChatCompletion(
    request: DomainChatCompletionRequest,
    conversationId: string | undefined,
    userId: string,
  ): Promise<DomainChatCompletionResult> {
    const typed = request as ChatRequestWithProtocolShape;

    // 1. Prepare raw messages
    const { messages, llmOptions, hasImage, hasText } = this.prepareLlmRequest(
      request,
      conversationId,
      userId,
    );

    const requestWithTips = await this.withAutoTipInjection(typed, messages);


    // 1.5 Directive Parsing (Intercept Slash Commands)
    // Check last user message
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      const text = lastMsg.parts.filter(p => p.type === 'text').map(p => p.text).join(' ');
      if (this.directiveParser.isDirective(text)) {
        const result = await this.directiveParser.parseAndExecute(text, userId);
        if (result.handled && result.content) {
            return {
                content: result.content,
                model: 'system',
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              timings: this.toTimings(createEmptyGenerationResult())
            };
        }
      }
    }

    // 2. Compact context if needed
    // Transform Multimodal -> Text Context for compaction
    const contextMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.parts.filter(p => p.type === 'text').map(p => p.text).join('\n')
    }));

    await this.hookPipeline?.emit('before_compaction', {
      conversationId: conversationId ?? 'ephemeral',
      userId,
      messages: contextMessages,
      model: llmOptions.model,
    });

    const compacted = await this.contextCompactor.compact({
      conversationId: conversationId ?? 'ephemeral',
      messages: contextMessages,
      systemPrompt: undefined, // Already in messages usually
      metadata: { model: llmOptions.model }
    }, {
      model: llmOptions.model,
      strategy: 'summarization' // Defaulting to summarization for smart context
    });

    await this.hookPipeline?.emit('after_compaction', {
      conversationId: conversationId ?? 'ephemeral',
      userId,
      beforeCount: contextMessages.length,
      afterCount: compacted.messages.length,
      messages: compacted.messages,
      model: llmOptions.model,
    });

    // 3. Re-map compacted text messages back to MultimodalChatMessage
    // We only replace if compaction actually happened (or strict enforcement)
    // Ideally we merge: keep latest image parts, but replace history with compacted.
    // For now, simpler approach: use compacted text messages.
    // WARNING: This strips images from history. This is generally acceptable for efficiency.
    const finalMessages = this.applyHermesSystemPrompt(
      compacted.messages.map(m => ({
        role: m.role,
        parts: [{ type: 'text', text: m.content }]
      })),
      requestWithTips,
    );

    const { adapter, provider } =
      await this.llmAdapterFactory.createAdapterWithFailover(
        undefined,
        llmOptions,
      );

    let result: LLMGenerationResult;

    if (hasImage) {
      // If original request had images, we should ensure the *latest* message (user query) 
      // retains its image parts if it wasn't dropped by compaction.
      // Compaction usually targets history.
      // Basic heuristic: Replace last message with original if roles match.
      const lastOriginal = messages[messages.length - 1];
      const lastCompacted = finalMessages[finalMessages.length - 1];
      
      if (lastOriginal && lastCompacted && lastOriginal.role === lastCompacted.role) {
         finalMessages[finalMessages.length - 1] = lastOriginal;
      }
      
      result = await adapter.generateMultimodalChat(finalMessages, llmOptions);
    } else {
      const prompt = this.buildTextPromptFromMessages(finalMessages);
      result = await adapter.generateText(prompt, llmOptions);
    }

    if (hasImage) {
      await this.ingestMultimodalChat({
        messages: finalMessages,
        llmOptions,
        result,
        provider,
        conversationId,
        userId,
        hasImage,
        hasText,
      });
    }

    await this.hookPipeline?.emit('agent_end', {
      success: true,
      conversationId: conversationId ?? 'ephemeral',
      userId,
      messages: this.toHookConversationMessages(finalMessages, result.text),
    });

    return this.toDomainCompletionResult(
      result,
      this.extractTipInjection(requestWithTips),
    );
  }

  async streamChatCompletion(
    request: DomainChatCompletionRequest,
    conversationId: string | undefined,
    userId: string,
    handlers: {
      onChunk: (chunk: string) => void;
      onReasoningChunk?: (reasoningChunk: string) => void;
      onProgress?: (update: {
        timings?: ChatMessageTimings;
        prompt_progress?: ChatMessagePromptProgress;
      }) => void;
      onComplete: (
        content: string,
        reasoning?: string,
        timings?: ChatMessageTimings,
        tipInjection?: TipInjectionResult,
      ) => void;
      onError: (error: Error) => void;
    },
  ): Promise<void> {
    try {
      const typed = request as ChatRequestWithProtocolShape;

      // 1. Prepare raw
      const { messages, llmOptions, hasImage, hasText } =
        this.prepareLlmRequest(request, conversationId, userId);

      const requestWithTips = await this.withAutoTipInjection(typed, messages);

      const streamOptions: LLMMultimodalGenerateOptions = {
        ...llmOptions,
        stream: false,
      };

      // 1.5 Directive Parsing (Intercept Slash Commands)
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        const text = lastMsg.parts.filter(p => p.type === 'text').map(p => p.text).join(' ');
        if (this.directiveParser.isDirective(text)) {
            const result = await this.directiveParser.parseAndExecute(text, userId);
            if (result.handled && result.content) {
            const timings = this.toTimings(createEmptyGenerationResult());
                handlers.onChunk(result.content);
          handlers.onComplete(result.content, undefined, timings, undefined);
                return;
            }
        }
      }

      // 2. Compact
      const contextMessages = messages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.parts.filter(p => p.type === 'text').map(p => p.text).join('\n')
      }));

      await this.hookPipeline?.emit('before_compaction', {
        conversationId: conversationId ?? 'ephemeral',
        userId,
        messages: contextMessages,
        model: llmOptions.model,
      });
  
      const compacted = await this.contextCompactor.compact({
        conversationId: conversationId ?? 'ephemeral',
        messages: contextMessages,
        metadata: { model: llmOptions.model }
      }, {
        model: llmOptions.model,
        strategy: 'summarization'
      });

      await this.hookPipeline?.emit('after_compaction', {
        conversationId: conversationId ?? 'ephemeral',
        userId,
        beforeCount: contextMessages.length,
        afterCount: compacted.messages.length,
        messages: compacted.messages,
        model: llmOptions.model,
      });
  
      const finalMessages = this.applyHermesSystemPrompt(
        compacted.messages.map(m => ({
          role: m.role,
          parts: [{ type: 'text', text: m.content }]
        })),
        requestWithTips,
      );

      const { adapter, provider } =
        await this.llmAdapterFactory.createAdapterWithFailover(
          undefined,
          streamOptions,
        );

      let result: LLMGenerationResult;

      if (hasImage) {
        // Restore last message image parts if applicable
        const lastOriginal = messages[messages.length - 1];
        const lastCompacted = finalMessages[finalMessages.length - 1];
        if (lastOriginal && lastCompacted && lastOriginal.role === lastCompacted.role) {
            finalMessages[finalMessages.length - 1] = lastOriginal;
        }

        result = await adapter.generateMultimodalChat(
          finalMessages,
          streamOptions,
        );
      } else {
        const prompt = this.buildTextPromptFromMessages(finalMessages);
        result = await adapter.generateText(prompt, streamOptions);
      }

      if (hasImage) {
        await this.ingestMultimodalChat({
          messages,
          llmOptions: streamOptions,
          result,
          provider,
          conversationId,
          userId,
          hasImage,
          hasText,
        });
      }

      const timings = this.toTimings(result);
      const tipInjection = this.extractTipInjection(requestWithTips);
      await this.hookPipeline?.emit('agent_end', {
        success: true,
        conversationId: conversationId ?? 'ephemeral',
        userId,
        messages: this.toHookConversationMessages(finalMessages, result.text),
      });

      if (result.text) {
        handlers.onChunk(result.text);
      }

      handlers.onProgress?.({ timings });
      handlers.onComplete(result.text, undefined, timings, tipInjection);
    } catch (error) {
      handlers.onError(
        error instanceof Error
          ? error
          : new Error('LLM streaming failed for chat completion'),
      );
    }
  }

  async sendMessage(
    request: { message?: string; [key: string]: unknown },
    userId: string,
  ): Promise<{
    ok: boolean;
    userId: string;
    echo: { message?: string; [key: string]: unknown };
  }> {
    return super.sendMessage(request, userId);
  }

  async regenerateMessage(
    messageId: string,
    userId: string,
  ): Promise<{ regenerated: boolean; messageId: string; userId: string }> {
    return super.regenerateMessage(messageId, userId);
  }

  async stopGeneration(conversationId: string, userId: string): Promise<void> {
    await super.stopGeneration(conversationId, userId);
  }

  async recordTipFeedback(tipIds: string[], helpful: boolean, userId: string, responseId?: string, comment?: string): Promise<void> {
    if (!this.adaptiveMemoryRetrieval?.recordTipFeedback) {
      return;
    }
    for (const tipId of tipIds) {
      this.adaptiveMemoryRetrieval.recordTipFeedback(tipId, true, helpful);
    }
  }

  private prepareLlmRequest(
    request: DomainChatCompletionRequest,
    conversationId: string | undefined,
    userId: string,
  ): {
    messages: MultimodalChatMessage[];
    llmOptions: LLMMultimodalGenerateOptions;
    hasImage: boolean;
    hasText: boolean;
  } {
    const typed = request as ChatRequestWithProtocolShape;
    const apiMessages = Array.isArray(typed.messages) ? typed.messages : [];

    const { messages, expectedModality, hasImage, hasText } =
      this.buildMultimodalMessages(apiMessages);

    const llmOptions: LLMMultimodalGenerateOptions = {
      model: typeof typed.model === 'string' ? typed.model : undefined,
      temperature:
        typeof typed.temperature === 'number' ? typed.temperature : undefined,
      maxTokens:
        typeof typed.max_tokens === 'number' ? typed.max_tokens : undefined,
      expectedModality,
      metadata: this.buildLlmMetadata(request, conversationId, userId, {
        expectedModality,
      }),
    };

    return { messages, llmOptions, hasImage, hasText };
  }

  private async withAutoTipInjection(
    request: ChatRequestWithProtocolShape,
    messages: readonly MultimodalChatMessage[],
  ): Promise<ChatRequestWithProtocolShape> {
    if (this.extractTipInjection(request)?.tipsInjected) {
      return request;
    }

    if (!this.adaptiveMemoryRetrieval || !this.tipGenerator) {
      return request;
    }

    const taskDescription = this.deriveTaskDescription(messages, request.message);
    if (!taskDescription) {
      return request;
    }

    try {
      const readinessBarriers: Promise<void>[] = [];
      if (this.adaptiveMemoryRetrieval.whenReady) {
        readinessBarriers.push(this.adaptiveMemoryRetrieval.whenReady());
      }
      if (this.tipGenerator.whenReady) {
        readinessBarriers.push(this.tipGenerator.whenReady());
      }
      await Promise.all(readinessBarriers);

      const usageAudit = this.adaptiveMemoryRetrieval.getUsageAudit?.();
      if (
        usageAudit &&
        usageAudit.totalFeedback > 0 &&
        this.tipGenerator.setHelpfulnessCalibration
      ) {
        this.tipGenerator.setHelpfulnessCalibration(usageAudit.helpfulRate);
      }

      const availableTips = mergeSessionLessonCandidatesIntoTips(
        this.tipGenerator.getAllTips(),
        this.extractSessionLessonCandidates(request),
      );

      const tipInjection = this.adaptiveMemoryRetrieval.retrieveAndInject(
        taskDescription,
        availableTips,
      );

      return {
        ...request,
        promptContext: {
          ...request.promptContext,
          tipInjection,
        },
      };
    } catch (error) {
      this.logger?.warn?.('[LLMBackedChatService] Automatic tip injection failed', {
        error,
        taskDescription,
      });
      return request;
    }
  }

  private buildMultimodalMessages(
    apiMessages: ApiChatMessageData[],
  ): {
    messages: MultimodalChatMessage[];
    expectedModality?: MultimodalContentType[];
    hasImage: boolean;
    hasText: boolean;
  } {
    let hasImage = false;
    let hasText = false;

    const messages: MultimodalChatMessage[] = apiMessages.map(
      (apiMessage): MultimodalChatMessage => {
        const parts: MultimodalContentPart[] = [];

        if (typeof apiMessage.content === 'string') {
          const text = apiMessage.content.trim();
          if (text) {
            hasText = true;
            parts.push({
              type: 'text',
              text,
            });
          }
        } else if (Array.isArray(apiMessage.content)) {
          for (const part of apiMessage.content) {
            if (part.type === 'text') {
             const text = (part.text || '').trim();
             if (text) {
               hasText = true;
               parts.push({
                 type: 'text',
                 text,
               });
             }
            } else if (
              part.type === 'image_url' &&
              part.image_url &&
              typeof part.image_url.url === 'string'
            ) {
              const url = part.image_url.url.trim();
              if (url) {
                hasImage = true;
                parts.push({
                  type: 'image',
                  imageBase64: url,
                });
              }
            } else if (part.type === 'input_audio' && part.input_audio) {
              // Ignored for now; reserved for future audio support.
            }
          }
        }

        if (parts.length === 0) {
          parts.push({
            type: 'text',
            text: '',
          });
        }

        return {
          role: apiMessage.role,
          parts,
        };
      },
    );

    const expectedModality = hasImage
      ? (['image'] as MultimodalContentType[])
      : undefined;

    return { messages, expectedModality, hasImage, hasText };
  }

  private deriveTaskDescription(
    messages: readonly MultimodalChatMessage[],
    fallbackMessage: unknown,
  ): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') {
        continue;
      }

      const text = this.extractTextContent(message);
      if (text) {
        return text;
      }
    }

    if (typeof fallbackMessage === 'string') {
      const text = fallbackMessage.trim();
      if (text) {
        return text;
      }
    }

    return undefined;
  }

  private buildLlmMetadata(
    request: DomainChatCompletionRequest,
    conversationId: string | undefined,
    userId: string,
    extra?: {
      expectedModality?: MultimodalContentType[];
    },
  ): Record<string, unknown> {
    let correlationId: string | undefined;
    try {
      correlationId = String(RequestContext.getCorrelationId());
    } catch {
      correlationId = undefined;
    }

    return {
      source: 'chat.completions',
      correlationId,
      conversationId,
      userId,
      model: (request as { model?: string }).model,
      expectedModality: extra?.expectedModality,
    };
  }

  private toHookConversationMessages(
    messages: readonly MultimodalChatMessage[],
    assistantText: string,
  ): Array<{ role: string; content: string }> {
    const serialized = messages.map((message) => ({
      role: message.role,
      content: this.extractTextContent(message),
    }));

    if (assistantText.trim().length > 0) {
      serialized.push({ role: 'assistant', content: assistantText });
    }

    return serialized;
  }

  private resolveIngestContext(
    conversationId: string | undefined,
    userId: string,
  ): {
    tenantId: string;
    sessionId: string;
    correlationId?: string;
  } {
    let tenantId: string | undefined;
    let sessionId: string | undefined;
    let correlationId: string | undefined;

    try {
      const context = RequestContext.getContext();
      tenantId = context.tenantId ? String(context.tenantId) : undefined;
      sessionId = context.sessionId ? String(context.sessionId) : undefined;
      correlationId = context.correlationId
        ? String(context.correlationId)
        : undefined;
    } catch {
      try {
        correlationId = String(RequestContext.getCorrelationId());
      } catch {
        correlationId = undefined;
      }
    }

    return {
      tenantId: tenantId ?? 'default',
      sessionId: conversationId ?? sessionId ?? `chat:${userId}`,
      correlationId,
    };
  }

  /**
   * Строит текстовый промпт из массива MultimodalChatMessage:
   * - берёт только text‑части;
   * - объединяет части одного сообщения через пробел;
   * - сообщения друг от друга отделяет двойным переводом строки.
   */
  private buildTextPromptFromMessages(
    messages: MultimodalChatMessage[],
  ): string {
    const chunks: string[] = [];

    for (const message of messages) {
      const textParts = message.parts
        .filter(
          (part) => part.type === 'text' && typeof part.text === 'string',
        )
        .map((part) => (part.text ?? '').trim())
        .filter(Boolean);

      if (textParts.length > 0) {
        chunks.push(textParts.join(' '));
      }
    }

    return chunks.join('\n\n').trim();
  }

  private applyHermesSystemPrompt(
    messages: MultimodalChatMessage[],
    request: ChatRequestWithProtocolShape,
  ): MultimodalChatMessage[] {
    const systemSections: string[] = [];
    const nonSystemMessages: MultimodalChatMessage[] = [];

    for (const message of messages) {
      if (message.role === 'system') {
        const systemText = this.extractTextContent(message);
        if (systemText) {
          systemSections.push(systemText);
        }
        continue;
      }

      nonSystemMessages.push(message);
    }

    const systemPrompt = this.buildHermesSystemPrompt(systemSections, request);
    if (!systemPrompt) {
      return messages;
    }

    return [
      {
        role: 'system',
        parts: [{ type: 'text', text: systemPrompt }],
      },
      ...nonSystemMessages,
    ];
  }

  private buildHermesSystemPrompt(
    baseSystemSections: readonly string[],
    request: ChatRequestWithProtocolShape,
  ): string {
    const baseSystemPrompt = baseSystemSections
      .map((section) => section.trim())
      .filter(Boolean)
      .join('\n\n');

    const tipInjection = this.extractTipInjection(request);
    if (!baseSystemPrompt && !tipInjection?.tipsInjected) {
      return '';
    }

    const layers: PromptLayer[] = [
      {
        id: 'base_system',
        name: 'Base System Prompt',
        priority: 0,
        required: true,
        build: () => baseSystemPrompt,
      },
      ...createDefaultPromptLayers(),
    ];

    const context: PromptBuildContext = {
      model: typeof request.model === 'string' ? request.model : undefined,
      availableTools: new Set<string>(),
      extra: tipInjection ? { tipInjection } : {},
    };

    return assembleSystemPrompt(layers, context).text.trim();
  }

  private extractTipInjection(
    request: ChatRequestWithProtocolShape,
  ): TipInjectionResult | undefined {
    return request.promptContext?.tipInjection ?? request.tipInjection;
  }

  private extractSessionLessonCandidates(
    request: ChatRequestWithProtocolShape,
  ): readonly SessionLessonCandidate[] | undefined {
    return request.promptContext?.sessionLessonCandidates ?? request.sessionLessonCandidates;
  }

  private extractTextContent(message: MultimodalChatMessage): string {
    return message.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => (part.text ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  private async ingestMultimodalChat(params: {
    messages: MultimodalChatMessage[];
    llmOptions: LLMMultimodalGenerateOptions;
    result: LLMGenerationResult;
    provider: string | undefined;
    conversationId: string | undefined;
    userId: string;
    hasImage: boolean;
    hasText: boolean;
  }): Promise<void> {
    if (!this.multimodalIngestUseCase) {
      return;
    }

    const { tenantId, sessionId, correlationId } = this.resolveIngestContext(
      params.conversationId,
      params.userId,
    );

    const responseText = params.result?.text ?? '';
    const model = params.result?.model ?? params.llmOptions.model;

    const ingestInput: MultimodalIngestInput = {
      tenantId,
      sessionId,
      userId: params.userId,
      source: 'chat.vision',
      items: [
        {
          modality: 'image',
          role: 'user',
          content: responseText,
          metadata: {
            requestMessages: params.messages,
            responseText,
            provider: params.provider,
            model,
            correlationId,
            hasImage: params.hasImage,
            hasText: params.hasText,
            conversationId: params.conversationId,
          },
        },
      ],
      correlationId,
    };

    try {
      await this.multimodalIngestUseCase.execute(ingestInput);
    } catch (error) {
      const logContext = {
        correlationId,
        tenantId,
        sessionId,
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : { message: String(error) },
      };
      if (this.logger) {
        this.logger.warn('[LLMBackedChatService] Multimodal ingest failed', logContext);
      } else {
         
        console.warn('[LLMBackedChatService] Multimodal ingest failed', logContext);
      }
    }
  }

  private toTimings(result: LLMGenerationResult): ChatMessageTimings {
    if (!result || typeof result !== 'object') {
      return {
        prompt_n: 0,
        predicted_n: 0,
        predicted_ms: 0,
        cache_n: 0,
      };
    }

    const usage = (result as Partial<LLMGenerationResult>).usage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    const durationValue = result.metadata?.durationMs;
    const durationMs = typeof durationValue === 'number' ? durationValue : 0;

    return {
      prompt_n: usage.promptTokens ?? 0,
      predicted_n: usage.completionTokens ?? 0,
      predicted_ms: durationMs,
      cache_n: 0,
    };
  }

  private toDomainCompletionResult(
    result: LLMGenerationResult,
    tipInjection?: TipInjectionResult,
  ): DomainChatCompletionResult {
    const timings = this.toTimings(result);

    const reasoningContent =
      (result.metadata?.reasoning_content as string | undefined) ?? undefined;

    return {
      content: result.text,
      reasoning: undefined,
      timings,
      model: result.model,
      reasoningContent,
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
      },
      tipInjection,
    };
  }
}