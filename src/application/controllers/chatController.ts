import type { ChatService, DomainChatCompletionRequest } from '../../domain/services/ChatService';
import type { TipInjectionResult } from '../../domain/memory/IAdaptiveMemoryRetrieval';
import { AuthService } from '../services/AuthService';
import { RateLimitService } from '../services/RateLimitService';
import express from 'express';
import * as core from 'express-serve-static-core';
import {
  ApiChatCompletionRequest,
  ApiChatCompletionResponse,
  ApiChatCompletionStreamChunk,
  ApiLlamaCppServerProps,
  ApiProcessingState,
  ProtocolUtils,
  ProtocolErrorCode,
} from '../../protocol/index';
import { SendMessageUseCase } from '../usecases/conversations';
import { RequestContext } from '../context/request-context';
import { BaseController } from './BaseController';
import {
  ChatCompletionRequestSchema,
  SendMessageRequestSchema,
  StopGenerationRequestSchema,
  TipFeedbackRequestSchema,
} from '../validators/api-schemas';

/**
 * Локальные HTTP-типы контроллера, основанные на Express.
 * Используем namespace-импорт express, чтобы получить реальные типы
 * Request/Response/NextFunction и при этом не тянуть runtime-зависимость в этот модуль.
 */
type Request = core.Request;
type Response = core.Response;

/**
 * Chat Controller - основной контроллер для LLM Chat API
 */
export class ChatController extends BaseController {
  /**
   * Конструктор с обратной совместимостью:
   * - Можно передать только 5 основных сервисов (как в старых тестах)
   * - Остальные use case зависимости можно передать через deps
   * - Если use case не передан, будет установлен безопасный stub, который возвращает ok: false
   */
  constructor(
    private chatService: ChatService,
    authService: AuthService,
    private rateLimitService: RateLimitService,
    private sendMessageUseCase: SendMessageUseCase,
    logger?: import('../../core/decorators/ILogger').ILogger,
  ) {
    super(authService, logger);
  }

  /**
   * POST /bff/chat/completions, POST /v1/chat/completions
   * Канонический контракт:
   * - Запрос/ответ соответствуют типам ApiChatCompletionRequest/ApiChatCompletionResponse из protocol-слоя.
   * - SSE-чанки соответствуют ApiChatCompletionStreamChunk.
   * - Ошибки маппятся через mapErrorToBffCode/bffToHttpStatus и отдаются в формате ProtocolResponse или SSE error payload.
   */
  async chatCompletions(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      await this.rateLimitService.checkLimit(authContext.userId, 'chat_completions');

      const request = req.body as ApiChatCompletionRequest;
      const conversationId = String((req.query as Record<string, unknown>)?.conversationId ?? '');

      // Валидация запроса
      this.validateChatCompletionRequest(request);

      if (request.stream) {
        await this.handleStreamingCompletion(request, conversationId, authContext, res);
      } else {
        const response = await this.handleNonStreamingCompletion(request, conversationId, authContext);
        res.json(response);
      }

    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  /**
   * Обработка потокового запроса (SSE).
   */
  private async handleStreamingCompletion(
    request: ApiChatCompletionRequest,
    conversationId: string,
    authContext: { userId: string },
    res: Response
  ): Promise<void> {
    // Установка заголовков для SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const domainRequest: DomainChatCompletionRequest = {
      ...request,
      model: request.model,
    };

    await this.chatService.streamChatCompletion(
      domainRequest,
      conversationId || undefined,
      authContext.userId,
      {
        onChunk: (chunk: string) => {
          const responseChunk: ApiChatCompletionStreamChunk = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: request.model || 'default',
            choices: [
              {
                index: 0,
                delta: { content: chunk },
                finish_reason: undefined,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(responseChunk)}\n\n`);
        },
        onReasoningChunk: (reasoningChunk: string) => {
           // Reasoning chunks (DeepSeek style) - optional extension
           // For now, we can treat them as content or ignore, or send specific event
           // Standard OpenAI API doesn't have specific field for reasoning in delta, 
           // but we can send it if client supports it or just ignore.
           // Let's ignore for standard compatibility or append to content if needed.
           // For now: ignore to match standard.
        },
        onComplete: (content: string, reasoning?: string, timings?: unknown, tipInjection?: TipInjectionResult) => {
          const finalChunk: ApiChatCompletionStreamChunk = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: request.model || 'default',
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop',
              },
            ],
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          if (tipInjection) {
            const tipPayload = {
              tip_injection: {
                tips_injected: tipInjection.tipsInjected,
                categories_represented: [...tipInjection.categoriesRepresented],
                tip_ids: tipInjection.tipIds ? [...tipInjection.tipIds] : undefined,
                injected_tips: tipInjection.injectedTips
                  ? tipInjection.injectedTips.map((tip) => ({
                    tip_id: tip.tipId,
                    source_kind: tip.sourceKind,
                    category: tip.category,
                  }))
                  : undefined,
              },
            };
            res.write(`data: ${JSON.stringify(tipPayload)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        },
        onError: (error: Error) => {
          // Если заголовки уже отправлены, мы не можем отправить JSON error.
          // Шлем SSE error event или просто закрываем стрим.
          const errPayload = {
            error: {
              message: error.message,
              type: 'internal_server_error',
              code: 'stream_error'
            }
          };
          res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
          res.end();
        },
      }
    );
  }

  /**
   * Обработка обычного (не потокового) запроса.
   */
  private async handleNonStreamingCompletion(
    request: ApiChatCompletionRequest,
    conversationId: string,
    authContext: { userId: string }
  ): Promise<ApiChatCompletionResponse> {
    const domainRequest: DomainChatCompletionRequest = {
      ...request,
      model: request.model,
    };

    const result = await this.chatService.generateChatCompletion(
      domainRequest,
      conversationId || undefined,
      authContext.userId
    );

    return {
      id: 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model || request.model || 'default',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content,
            reasoning_content: result.reasoningContent, // Optional extension
          },
          finish_reason: 'stop',
        },
      ],
      usage: result.usage ? {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.totalTokens
      } : undefined,
      tip_injection: result.tipInjection ? {
        tips_injected: result.tipInjection.tipsInjected,
        categories_represented: [...result.tipInjection.categoriesRepresented],
        tip_ids: result.tipInjection.tipIds
          ? [...result.tipInjection.tipIds]
          : undefined,
        injected_tips: result.tipInjection.injectedTips
          ? result.tipInjection.injectedTips.map((tip) => ({
            tip_id: tip.tipId,
            source_kind: tip.sourceKind,
            category: tip.category,
          }))
          : undefined,
      } : undefined,
    };
  }

  private validateChatCompletionRequest(request: unknown): asserts request is ApiChatCompletionRequest {
    const result = ChatCompletionRequestSchema.safeParse(request);
    if (!result.success) {
      const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Validation error: ${errors}`);
    }
  }

  /**
   * GET /bff/props - Каноничный BFF endpoint.
   * Возвращает ProtocolResponse<ApiLlamaCppServerProps>.
   */
  async getServerProps(req: Request, res: Response): Promise<void> {
    try {
      await this.authenticateRequestTyped(req);
      const props: ApiLlamaCppServerProps = await this.chatService.getServerProperties();
      res.json(ProtocolUtils.success(props));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  /**
   * GET /bff/slots - Каноничный BFF endpoint.
   * Возвращает ProtocolResponse<ApiProcessingState[]>.
   */
  async getSlots(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      const conversationId = String((req.query as Record<string, unknown>)?.conversationId ?? '');

      const slotsState: ApiProcessingState = await this.chatService.getProcessingState(
        conversationId,
        authContext.userId
      );

      res.status(200).json(ProtocolUtils.success(slotsState));

    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  // ================== RAW FACADE ENDPOINTS (llama.cpp WebUI) ==================

  /**
   * GET /props (RAW) — llama.cpp совместимый формат.
   * Используется только как фасад; возвращает RAW JSON без ProtocolResponse.
   */
  async getServerPropsRaw(req: Request, res: Response): Promise<void> {
    try {
      // RAW-фасад использует ту же строгую аутентификацию, что и BFF
      await this.authenticateRequestTyped(req);

      const props = await this.chatService.getServerProperties();
      const primary = props?.models?.[0];

      const model_alias = primary?.id || 'default';
      const model_path = (primary?.root || primary?.id || null);

      const raw = {
        model_alias,
        model_path,
        modalities: {
          vision: Boolean(props?.capabilities?.multimodal ?? false),
          audio: false
        },
        default_generation_settings: {
          params: {
            temperature: 0.7,
            top_p: 0.95
          }
        },
        total_slots: 1
      };

      res.json(raw);
    } catch (error) {
      // Для RAW можно вернуть канон-ошибку, WebUI парсит error.message
      this.handleControllerError(error, res);
    }
  }

  /**
   * GET /slots (RAW) — возвращает массив слотов или 501
   */
  async getSlotsRaw(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      const conversationId = String((req.query as Record<string, unknown>)?.conversationId ?? '');

      let nctx = 4096;
      try {
        const state = await this.chatService.getProcessingState(conversationId || '', authContext.userId);
        if (state?.contextTotal && state.contextTotal > 0) {
          nctx = state.contextTotal;
        }
      } catch {
        // ignore, fallback to default
      }

      const slots = [
        {
          id: 0,
          n_ctx: nctx,
          processing: false
        }
      ];

      res.json(slots);
    } catch (_e) {
      res.status(501).json({ error: { message: 'Slots endpoint not implemented' } });
    }
  }

  /**
   * GET /v1/models — OpenAI-style список моделей (RAW)
   */
  async getModels(req: Request, res: Response): Promise<void> {
    try {
      await this.authenticateRequestTyped(req);
      const props = await this.chatService.getServerProperties();

      const data = (props?.models || []).map((m) => ({
        id: m.id,
        object: 'model',
        created: m.created,
        owned_by: m.owned_by,
        permission: m.permission,
        root: m.root,
        parent: m.parent
      }));

      res.json({
        object: 'list',
        data
      });
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async sendMessage(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      await this.rateLimitService.checkLimit(authContext.userId, 'send_message');

      const parseResult = SendMessageRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json(
          ProtocolUtils.error(
            ProtocolErrorCode.VALIDATION_ERROR,
            'Invalid request body',
            parseResult.error.flatten()
          )
        );
        return;
      }

      const request = parseResult.data;

      const result = await this.sendMessageUseCase.execute({
        conversationId: request.conversationId,
        authorId: authContext.userId,
        content: request.message,
        parentMessageId: request.parentMessageId,
        metadata: request.metadata,
        messageType: 'text'
      });
 
      if (!result.ok || !result.data) {
        return void this.handleResultError(result, res);
      }
 
      const { conversation } = result.data;
      res.json(ProtocolUtils.success(conversation));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async regenerateMessage(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      const params = req.params as Record<string, string> || {};
      const messageId = String(params.id || '');

      const result = await this.chatService.regenerateMessage(messageId, authContext.userId);
      
      res.json(ProtocolUtils.success(result));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async stopGeneration(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      
      const parseResult = StopGenerationRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json(
          ProtocolUtils.error(
            ProtocolErrorCode.VALIDATION_ERROR,
            'Invalid request body',
            parseResult.error.flatten()
          )
        );
        return;
      }

      await this.chatService.stopGeneration(parseResult.data.conversationId, authContext.userId);
      
      res.json(ProtocolUtils.success({ stopped: true }));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async handleTipFeedback(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);

      const parseResult = TipFeedbackRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json(
          ProtocolUtils.error(
            ProtocolErrorCode.VALIDATION_ERROR,
            'Invalid request body',
            parseResult.error.flatten()
          )
        );
        return;
      }

      const { tip_ids, helpful, response_id, comment } = parseResult.data;

      await this.chatService.recordTipFeedback(tip_ids, helpful, authContext.userId, response_id, comment);

      res.json(ProtocolUtils.success({ recorded: true, tip_ids, helpful }));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }
}