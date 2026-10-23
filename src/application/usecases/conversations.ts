import { IConversationRepository } from '../../domain/conversation/IConversationRepository';
import { Conversation } from '../../domain/conversation/Conversation';
import { ConversationId } from '../../domain/conversation/ConversationId';
import { ParticipantId } from '../../domain/conversation/ParticipantId';
import { DomainEvent } from '../../domain/events/event-store.interface';
import type { DomainFileUploadInput, DomainFileUploadResult } from '../../domain/services/FileProcessingService';

// Удалены импорты Domain интерфейсов
import { EventStoreService } from '../services/EventStoreService';
import { EventBusService } from '../services/EventBusService';

import { ConversationDomainEvent } from '../../domain/conversation/events';
import { toDomainEvents } from '../events/conversation-event-adapter';
import { getCorrelationId, UseCaseResult } from './shared/use-case.utils';
import { IInboundContextProcessor } from '../../domain/interaction/InboundContextProcessor';
import { IAgentRunner } from '../../domain/agent-runner/agent-runner.port';
import { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';
import type { IAdaptiveMemoryRetrieval } from '../../domain/memory/IAdaptiveMemoryRetrieval';
import type { IProfileMemory } from '../../domain/memory/IProfileMemory';
import { bestMemoryWindow } from '../../domain/memory/memory-snippet';
import type {
  IUserFeedbackCollector,
  UserFeedback,
} from '../../domain/feedback/user-feedback-collector.interface';
import { RequestContext } from '../context/request-context';

/** Участник, от имени которого в диалог пишется ответ модели. */
const DIALOG_ASSISTANT_ID = 'bot_assistant';

export interface DialogReplyGenerator {
  generateChatCompletion(
    request: { messages?: Array<{ role: string; content: string }>; model?: string },
    conversationId: string | undefined,
    userId: string,
  ): Promise<{ content?: string; model?: string }>;
}

export type { UseCaseResult };

type TimFeedbackImplicitSignal = 'regenerated' | 'copied' | 'follow_up';

interface TimFeedbackMetadata {
  readonly responseId?: string;
  readonly tipIds: readonly string[];
  readonly used?: boolean;
  readonly helpful?: boolean;
  readonly implicit?: TimFeedbackImplicitSignal;
  readonly rating?: number;
  readonly thumbs?: 'up' | 'down';
  readonly correction?: string;
}

/**
 * Публикация доменных событий агрегата через Outbox-aware EventStoreService.
 *
 * Инварианты (синхронизировано с SSOT/AGENTS):
 * - Надежная доставка:
 *   - если IOutbox сконфигурирован, EventStoreService.saveDomainEvents()
 *     использует outbox.saveEventsWithOutbox(...) → persist-then-enqueue;
 *   - публикацией в IEventBus занимается Outbox-воркер на инфраструктурном уровне.
 * - В Application-слое запрещена двойная маршрутизация (persist + повторный reliablePublish
 *   для тех же событий), чтобы избежать потенциальных дублей и расхождений.
 * - Для немедленных, некритичных внутренних нотификаций следует использовать отдельные
 *   fastPublish*-вызовы с другим набором событий, но не для основных доменных ES-событий.
 */
async function publishAggregateEvents(
  events: ConversationDomainEvent[],
  eventStore: EventStoreService,
  _eventBus?: EventBusService
): Promise<void> {
  if (!events || events.length === 0) return;

  const mapped: DomainEvent[] = toDomainEvents(events);

  // Outbox-first:
  // - Вся надежная публикация доменных событий выполняется через EventStoreService/Outbox.
  // - Дополнительный вызов EventBusService.reliablePublishDomainEvents(mapped) здесь
  //   запрещен, чтобы не дублировать enqueue/publish одного и того же события.
  await eventStore.saveDomainEvents(mapped);
}

/**
 * 1) CreateConversationUseCase
 */
export interface CreateConversationInput {
  userId: string;
  title?: string;
  participantIds?: string[];
  metadata?: Record<string, unknown>;
}
export interface CreateConversationOutput {
  conversation: ReturnType<Conversation['serialize']>;
}
export class CreateConversationUseCase {
  constructor(
    private readonly repo: IConversationRepository,
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBusService
  ) {}

  async execute(input: CreateConversationInput): Promise<UseCaseResult<CreateConversationOutput>> {
    try {
      if (!input.userId || input.userId.trim().length === 0) {
        return { ok: false, error: { code: 'VALIDATION', message: 'userId is required' } };
      }

      const corr = getCorrelationId();

      const conversation = Conversation.create({
        createdBy: input.userId,
        title: input.title,
        participantIds: input.participantIds,
        metadata: input.metadata,
        correlationId: corr
      });

      // 1) Сохраняем агрегат в репозиторий (read model)
      const saved = await this.repo.save(conversation);
      if (!saved.success) {
        return { ok: false, error: { code: 'REPOSITORY', message: saved.error.message } };
      }

      // 2) Публикуем доменные события через Event Store Service + Event Bus
      await publishAggregateEvents(conversation.getEvents() as ConversationDomainEvent[], this.eventStore, this.eventBus);
      
      // 3) Очищаем события агрегата (после успешной записи и публикации)
      conversation.clearEvents();

      return { ok: true, data: { conversation: saved.data.serialize() } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Create conversation failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}

/**
 * 2) GetConversationUseCase
 */
export interface GetConversationInput {
  conversationId: string;
  userId: string;
}
export interface GetConversationOutput {
  conversation: ReturnType<Conversation['serialize']>;
}
export class GetConversationUseCase {
  constructor(
    private readonly repo: IConversationRepository
  ) {}

  async execute(input: GetConversationInput): Promise<UseCaseResult<GetConversationOutput>> {
    try {
      if (!ConversationId.isValid(input.conversationId)) {
        return { ok: false, error: { code: 'VALIDATION', message: 'Invalid conversationId' } };
      }
      const id = ConversationId.fromString(input.conversationId);

      const result = await this.repo.findById(id);
      if (!result.success) {
        return { ok: false, error: { code: 'NOT_FOUND', message: result.error.message } };
      }

      // Опциональная авторизация: пользователь должен быть участником
      const conv = result.data;
      const pid = ParticipantId.fromString(input.userId);
      const isParticipant = conv.participants.some(p => p.id.equals(pid));
      if (!isParticipant && conv.createdBy !== input.userId) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'User has no access to this conversation' } };
      }

      return { ok: true, data: { conversation: conv.serialize() } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Get conversation failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}

/**
 * 3) AddParticipantUseCase
 */
export interface AddParticipantInput {
  conversationId: string;
  addedBy: string;
  participantId: string;
  role?: 'member' | 'admin' | 'observer';
}
export interface AddParticipantOutput {
  conversation: ReturnType<Conversation['serialize']>;
}
export class AddParticipantUseCase {
  constructor(
    private readonly repo: IConversationRepository,
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBusService
  ) {}

  async execute(input: AddParticipantInput): Promise<UseCaseResult<AddParticipantOutput>> {
    try {
      if (!ConversationId.isValid(input.conversationId)) {
        return { ok: false, error: { code: 'VALIDATION', message: 'Invalid conversationId' } };
      }
      const id = ConversationId.fromString(input.conversationId);

      const found = await this.repo.findById(id);
      if (!found.success) {
        return { ok: false, error: { code: 'NOT_FOUND', message: found.error.message } };
      }

      const conv = found.data;

      const corr = getCorrelationId();

      conv.addParticipant({
        participantId: input.participantId,
        addedBy: input.addedBy,
        role: input.role,
        correlationId: corr
      });

      // 1) Сохраняем агрегат в репозиторий (read model)
      const saved = await this.repo.save(conv);
      if (!saved.success) {
        return { ok: false, error: { code: 'REPOSITORY', message: saved.error.message } };
      }

      // 2) Публикуем доменные события через Event Store Service + Event Bus
      await publishAggregateEvents(conv.getEvents() as ConversationDomainEvent[], this.eventStore, this.eventBus);
       
      // 3) Очищаем события агрегата (после успешной записи и публикации)
      conv.clearEvents();

      return { ok: true, data: { conversation: saved.data.serialize() } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Add participant failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}

/**
 * 4) ArchiveConversationUseCase
 */
export interface ArchiveConversationInput {
  conversationId: string;
  archivedBy: string;
  reason?: string;
}
export interface ArchiveConversationOutput {
  conversation: ReturnType<Conversation['serialize']>;
}
export class ArchiveConversationUseCase {
  constructor(
    private readonly repo: IConversationRepository,
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBusService
  ) {}

  async execute(input: ArchiveConversationInput): Promise<UseCaseResult<ArchiveConversationOutput>> {
    try {
      if (!ConversationId.isValid(input.conversationId)) {
        return { ok: false, error: { code: 'VALIDATION', message: 'Invalid conversationId' } };
      }
      const id = ConversationId.fromString(input.conversationId);

      const found = await this.repo.findById(id);
      if (!found.success) {
        return { ok: false, error: { code: 'NOT_FOUND', message: found.error.message } };
      }

      const conv = found.data;

      const corr = getCorrelationId();

      conv.archive(input.archivedBy, input.reason, corr);

      // 1) Сохраняем агрегат в репозиторий (read model)
      const saved = await this.repo.save(conv);
      if (!saved.success) {
        return { ok: false, error: { code: 'REPOSITORY', message: saved.error.message } };
      }

      // 2) Публикуем доменные события через Event Store Service + Event Bus
      await publishAggregateEvents(conv.getEvents() as ConversationDomainEvent[], this.eventStore, this.eventBus);
       
      // 3) Очищаем события агрегата (после успешной записи и публикации)
      conv.clearEvents();

      return { ok: true, data: { conversation: saved.data.serialize() } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Archive conversation failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}

/**
 * 5) SendMessageUseCase
 * Примечание: это доменная отправка сообщения в Conversation (не LLM генерация).
 */
export interface SendMessageInput {
  conversationId: string;
  authorId: string;
  content: string;
  messageType?: 'text' | 'image' | 'file' | 'system';
  parentMessageId?: string;
  metadata?: Record<string, unknown>;
}
export interface SendMessageOutput {
  conversation: ReturnType<Conversation['serialize']>;
}
export class SendMessageUseCase {
  constructor(
    private readonly repo: IConversationRepository,
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBusService,
    // Optional injection to allow staged migration or testing without agent system
    private readonly contextProcessor?: IInboundContextProcessor,
    private readonly agentRunner?: IAgentRunner,
    private readonly logger?: ILogger,
    private readonly adaptiveMemoryRetrieval?: IAdaptiveMemoryRetrieval,
    private readonly userFeedbackCollector?: IUserFeedbackCollector,
    private readonly dialogReply?: DialogReplyGenerator,
    private readonly profileMemory?: IProfileMemory,
  ) {}

  async execute(input: SendMessageInput): Promise<UseCaseResult<SendMessageOutput>> {
    try {
      if (!ConversationId.isValid(input.conversationId)) {
        return { ok: false, error: { code: 'VALIDATION', message: 'Invalid conversationId' } };
      }
      if (!input.content || input.content.trim().length === 0) {
        return { ok: false, error: { code: 'VALIDATION', message: 'content is required' } };
      }

      const id = ConversationId.fromString(input.conversationId);
      const found = await this.repo.findById(id);
      if (!found.success) {
        return { ok: false, error: { code: 'NOT_FOUND', message: found.error.message } };
      }

      const conv = found.data;

      const corr = getCorrelationId();

      conv.addMessage({
        content: input.content,
        authorId: input.authorId,
        messageType: input.messageType,
        parentMessageId: input.parentMessageId,
        metadata: input.metadata,
        correlationId: corr
      });

      await this.appendAssistantReply(conv, input, corr);

      // 1) Сохраняем агрегат в репозиторий (read model)
      const saved = await this.repo.save(conv);
      if (!saved.success) {
        return { ok: false, error: { code: 'REPOSITORY', message: saved.error.message } };
      }

      await this.rememberUserMessage(input, corr);

      // 2) Публикуем доменные события через Event Store Service + Event Bus
      await publishAggregateEvents(conv.getEvents() as ConversationDomainEvent[], this.eventStore, this.eventBus);
       
      // 3) Очищаем события агрегата (после успешной записи и публикации)
      conv.clearEvents();

      await this.processTimFeedback(
        input.metadata,
        corr,
        input.conversationId,
        input.authorId,
      );

      // 4) [COGNITIVE LOOP] Process Inbound Message -> Agent Task
      if (this.contextProcessor && this.agentRunner) {
          try {
              const task = await this.contextProcessor.process({
                  content: input.content,
                  senderId: input.authorId,
                  conversationId: input.conversationId,
                  metadata: input.metadata
              });

              if (task) {
                  const taskId = await this.agentRunner.submitTask(task);
                  this.logger?.debug('Cognitive Loop: Task submitted', { 
                      taskId, 
                      conversationId: input.conversationId,
                      senderId: input.authorId
                  });
              }
          } catch (err) {
              const error = err instanceof Error ? err : new Error(String(err));
              // Critical: Do NOT fail the User's "Send Message" request just because Agent failed to wake up.
              // Log the error securely.
              this.logger?.error('Cognitive Loop Entry Failed', { 
                  error: error.message, 
                  stack: error.stack,
                  conversationId: input.conversationId 
              });
              if (!this.logger) console.error('Cognitive Loop Entry Failed (Fallback):', err);
          }
      }

      return { ok: true, data: { conversation: saved.data.serialize() } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Send message failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }

  private async rememberUserMessage(
    input: SendMessageInput,
    correlationId: string | undefined,
  ): Promise<void> {
    if (!this.profileMemory) {
      return;
    }

    let tenantId: string | undefined;
    let userId = input.authorId;
    try {
      const context = RequestContext.getContext();
      tenantId = context.tenantId ? String(context.tenantId) : undefined;
      if (context.userId) {
        userId = String(context.userId);
      }
    } catch {
      tenantId = undefined;
    }

    if (!tenantId) {
      return;
    }

    try {
      await this.profileMemory.writeProfileEntries({
        tenantId,
        userId,
        correlationId,
        mode: 'merge',
        entries: [{
          type: 'user_profile',
          summary: input.content.trim(),
          importance: 0.5,
          timestamp: new Date().toISOString(),
          metadata: {
            conversationId: input.conversationId,
            role: 'user',
          },
        }],
      });
    } catch (error) {
      this.logger?.warn('Profile memory was not stored', {
        conversationId: input.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async appendAssistantReply(
    conv: Conversation,
    input: SendMessageInput,
    correlationId: string | undefined,
  ): Promise<void> {
    if (!this.dialogReply) {
      return;
    }

    let content = '';
    let model: string | undefined;
    try {
      const messages = await this.buildDialogPromptMessages(conv, input);
      const result = await this.dialogReply.generateChatCompletion(
        { messages },
        input.conversationId,
        input.authorId,
      );
      content = typeof result.content === 'string' ? result.content.trim() : '';
      model = result.model;
    } catch (error) {
      this.logger?.warn('Dialog reply was not generated', {
        conversationId: input.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (content.length === 0) {
      return;
    }

    const assistantId = ParticipantId.fromString(DIALOG_ASSISTANT_ID);
    const present = conv.participants.some((participant) => participant.id.equals(assistantId));
    try {
      if (!present) {
        conv.addParticipant({
          participantId: DIALOG_ASSISTANT_ID,
          addedBy: input.authorId,
          role: 'member',
          correlationId,
        });
      }
      conv.addMessage({
        content,
        authorId: DIALOG_ASSISTANT_ID,
        messageType: 'text',
        metadata: { role: 'assistant', ...(model ? { model } : {}) },
        correlationId,
      });
    } catch (error) {
      this.logger?.warn('Dialog reply was not stored', {
        conversationId: input.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async buildDialogPromptMessages(
    conv: Conversation,
    input: SendMessageInput,
  ): Promise<Array<{ role: string; content: string }>> {
    const promptMessages: Array<{ role: string; content: string }> = [];
    const currentTrimmed = input.content.trim();

    if (this.profileMemory && typeof this.profileMemory.search === 'function') {
      let tenantId: string | undefined;
      let userId = input.authorId;
      try {
        const context = RequestContext.getContext();
        tenantId = context.tenantId ? String(context.tenantId) : undefined;
        if (context.userId) {
          userId = String(context.userId);
        }
      } catch {
        tenantId = undefined;
      }

      if (tenantId) {
        try {
          const entries = await this.profileMemory.search({
            tenantId,
            userId,
            query: currentTrimmed,
            limit: 5,
          });
          const seen = new Set<string>();
          const summaries: string[] = [];
          for (const entry of entries ?? []) {
            const raw = typeof entry?.summary === 'string' ? entry.summary.trim() : '';
            const summary = raw.length > 800 ? bestMemoryWindow(raw, currentTrimmed, 800) : raw;
            if (summary.length === 0 || summary === currentTrimmed || seen.has(summary)) {
              continue;
            }
            seen.add(summary);
            summaries.push(summary);
          }
          if (summaries.length > 0) {
            promptMessages.push({
              role: 'system',
              content: `Контекст долгой памяти пользователя:\n${summaries.map((item) => `- ${item}`).join('\n')}`,
            });
          }
        } catch (error) {
          this.logger?.warn('Profile memory recall failed', {
            conversationId: input.conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const history = Array.isArray(conv.messages) ? conv.messages : [];
    for (const msg of history) {
      const msgContent = typeof msg?.content === 'string' ? msg.content.trim() : '';
      if (msgContent.length === 0) {
        continue;
      }
      const authorIdObj = msg.authorId as { toValue?: () => string; value?: string } | undefined;
      const authorValue = typeof authorIdObj?.toValue === 'function'
        ? authorIdObj.toValue()
        : String(authorIdObj?.value ?? '');
      const metaRole = msg.metadata?.['role'];
      const role = metaRole === 'assistant' || metaRole === 'system'
        ? metaRole
        : authorValue === DIALOG_ASSISTANT_ID
          ? 'assistant'
          : 'user';
      promptMessages.push({ role, content: msgContent });
    }

    const lastTurn = promptMessages[promptMessages.length - 1];
    if (!lastTurn || lastTurn.role !== 'user' || lastTurn.content !== currentTrimmed) {
      promptMessages.push({ role: 'user', content: currentTrimmed });
    }

    return promptMessages;
  }

  private async processTimFeedback(
    metadata: Record<string, unknown> | undefined,
    correlationId: string | undefined,
    conversationId: string,
    authorId: string,
  ): Promise<void> {
    const feedback = this.extractTimFeedbackMetadata(metadata);
    if (!feedback) {
      return;
    }

    try {
      const tipOutcome = this.deriveTipOutcome(feedback);
      if (
        tipOutcome &&
        feedback.tipIds.length > 0 &&
        this.adaptiveMemoryRetrieval?.recordTipFeedback
      ) {
        for (const tipId of feedback.tipIds) {
          this.adaptiveMemoryRetrieval.recordTipFeedback(
            tipId,
            tipOutcome.used,
            tipOutcome.helpful,
          );
        }
      }

      const collectorPayload = this.buildCollectorPayload(feedback, tipOutcome);
      if (
        collectorPayload &&
        correlationId &&
        this.userFeedbackCollector
      ) {
        await this.userFeedbackCollector.collect(
          collectorPayload,
          correlationId as CorrelationId,
        );
      }
    } catch (error) {
      this.logger?.warn('TIM feedback side effects failed', {
        conversationId,
        authorId,
        responseId: feedback.responseId,
        tipIds: feedback.tipIds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildCollectorPayload(
    feedback: TimFeedbackMetadata,
    tipOutcome: { used: boolean; helpful: boolean } | undefined,
  ): UserFeedback | undefined {
    if (!feedback.responseId) {
      return undefined;
    }

    const thumbs = feedback.thumbs
      ?? (tipOutcome ? (tipOutcome.helpful ? 'up' : 'down') : undefined);

    if (
      feedback.rating === undefined &&
      thumbs === undefined &&
      feedback.correction === undefined &&
      feedback.implicit === undefined
    ) {
      return undefined;
    }

    return {
      responseId: feedback.responseId,
      rating: feedback.rating,
      thumbs,
      correction: feedback.correction,
      implicit: feedback.implicit,
    };
  }

  private deriveTipOutcome(
    feedback: TimFeedbackMetadata,
  ): { used: boolean; helpful: boolean } | undefined {
    if (typeof feedback.helpful === 'boolean') {
      return {
        used: feedback.used ?? true,
        helpful: feedback.helpful,
      };
    }

    switch (feedback.implicit) {
      case 'copied':
        return { used: true, helpful: true };
      case 'follow_up':
      case 'regenerated':
        return { used: true, helpful: false };
      default:
        return undefined;
    }
  }

  private extractTimFeedbackMetadata(
    metadata: Record<string, unknown> | undefined,
  ): TimFeedbackMetadata | undefined {
    if (!metadata) {
      return undefined;
    }

    const candidate = this.asRecord(metadata.tim_feedback)
      ?? this.asRecord(metadata.timFeedback);

    if (!candidate) {
      return undefined;
    }

    const responseId = this.readString(candidate.response_id)
      ?? this.readString(candidate.responseId);
    const tipIds = this.readStringArray(candidate.tip_ids)
      ?? this.readStringArray(candidate.tipIds)
      ?? [];
    const used = typeof candidate.used === 'boolean' ? candidate.used : undefined;
    const helpful = typeof candidate.helpful === 'boolean' ? candidate.helpful : undefined;
    const implicit = this.readImplicitSignal(candidate.implicit);
    const thumbs = candidate.thumbs === 'up' || candidate.thumbs === 'down'
      ? candidate.thumbs
      : undefined;
    const rating = typeof candidate.rating === 'number' && Number.isFinite(candidate.rating)
      ? candidate.rating
      : undefined;
    const correction = this.readString(candidate.correction);

    if (
      responseId === undefined &&
      tipIds.length === 0 &&
      used === undefined &&
      helpful === undefined &&
      implicit === undefined &&
      thumbs === undefined &&
      rating === undefined &&
      correction === undefined
    ) {
      return undefined;
    }

    return {
      responseId,
      tipIds,
      used,
      helpful,
      implicit,
      thumbs,
      rating,
      correction,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null
      ? value as Record<string, unknown>
      : undefined;
  }

  private readString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private readStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    return value
      .map((entry) => this.readString(entry))
      .filter((entry): entry is string => entry !== undefined);
  }

  private readImplicitSignal(value: unknown): TimFeedbackImplicitSignal | undefined {
    return value === 'regenerated' || value === 'copied' || value === 'follow_up'
      ? value
      : undefined;
  }
}

/**
 * 6) UpdateConversationUseCase (минимальная версия — изменение title/metadata без отдельного доменного события)
 * В будущем можно ввести ConversationUpdated событие и перевести на ES.
 */
export interface UpdateConversationInput {
  conversationId: string;
  userId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}
export interface UpdateConversationOutput {
  conversation: ReturnType<Conversation['serialize']>;
}
export class UpdateConversationUseCase {
  constructor(
    private readonly repo: IConversationRepository
  ) {}

  async execute(input: UpdateConversationInput): Promise<UseCaseResult<UpdateConversationOutput>> {
    try {
      if (!ConversationId.isValid(input.conversationId)) {
        return { ok: false, error: { code: 'VALIDATION', message: 'Invalid conversationId' } };
      }
      const id = ConversationId.fromString(input.conversationId);

      const found = await this.repo.findById(id);
      if (!found.success) {
        return { ok: false, error: { code: 'NOT_FOUND', message: found.error.message } };
      }
      const current = found.data.serialize();

      // Проверка прав — владелец или админ
      const isOwner = current.createdBy === input.userId;
      const isAdmin = (current.participants as Array<{ role?: string; id?: string }>)?.some?.((p) => p.role === 'admin' && p.id === `user_${input.userId}`) || false;
      if (!isOwner && !isAdmin) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Only owner or admin can update conversation' } };
      }

      // Минимальная стратегия: восстановить агрегат и пере-собрать props (без доменного события)
      const restoredProps: Conversation['props'] = {
        createdBy: current.createdBy as string,
        title: input.title ?? (current.title as string | undefined),
        createdAt: found.data.createdAt,
        messages: [...found.data.messages],
        participants: [...found.data.participants],
        status: found.data.status,
        updatedAt: found.data.updatedAt,
        metadata: input.metadata ?? (current.metadata as Record<string, unknown> | undefined),
      };

      const restored = Conversation.restore(
        ConversationId.fromString(current.id as string),
        restoredProps,
        (current.version as number) || 0
      );

      const saved = await this.repo.save(restored);
      if (!saved.success) {
        return { ok: false, error: { code: 'REPOSITORY', message: saved.error.message } };
      }

      return { ok: true, data: { conversation: saved.data.serialize() } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Update conversation failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}

/**
 * 7) ListConversationsUseCase
 */
export interface ListConversationsInput {
  userId: string;
  limit?: number;
  offset?: number;
  status?: 'active' | 'archived' | 'deleted';
}
export interface ListConversationsOutput {
  conversations: ReturnType<Conversation['serialize']>[];
  total: number;
  count: number;
  offset: number;
  limit: number;
}
export class ListConversationsUseCase {
  constructor(
    private readonly repo: IConversationRepository
  ) {}

  async execute(input: ListConversationsInput): Promise<UseCaseResult<ListConversationsOutput>> {
    try {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
      const offset = Math.max(0, input.offset ?? 0);

      const result = await this.repo.find({
        createdBy: input.userId,
        status: input.status,
        limit,
        offset,
        sortBy: 'updatedAt',
        sortOrder: 'desc'
      });

      if (!result.success) {
        return { ok: false, error: { code: 'REPOSITORY', message: result.error.message } };
      }

      const conversations = result.data.conversations.map(c => c.serialize());
      return {
        ok: true,
        data: {
          conversations,
          total: result.data.total,
          count: result.data.count,
          offset: result.data.offset,
          limit: result.data.limit
        }
      };
    } catch (e: unknown) {
      return { ok: false, error: { code: 'UNEXPECTED', message: e instanceof Error ? e.message : 'List conversations failed' } };
    }
  }
}

/**
 * 8) DeleteConversationUseCase (soft-delete через репозиторий)
 */
export interface DeleteConversationInput {
  conversationId: string;
  userId: string;
}
export interface DeleteConversationOutput {
  deleted: boolean;
}
export class DeleteConversationUseCase {
  constructor(
    private readonly repo: IConversationRepository
  ) {}

  async execute(input: DeleteConversationInput): Promise<UseCaseResult<DeleteConversationOutput>> {
    try {
      if (!ConversationId.isValid(input.conversationId)) {
        return { ok: false, error: { code: 'VALIDATION', message: 'Invalid conversationId' } };
      }
      const id = ConversationId.fromString(input.conversationId);

      const found = await this.repo.findById(id);
      if (!found.success) {
        return { ok: false, error: { code: 'NOT_FOUND', message: found.error.message } };
      }

      const conv = found.data;
      const isOwner = conv.createdBy === input.userId;
      const isAdmin = conv.participants.some(
        p => p.id.equals(ParticipantId.fromString(input.userId)) && p.role === 'admin'
      );
      if (!isOwner && !isAdmin) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Only owner or admin can delete conversation' } };
      }

      const del = await this.repo.delete(id);
      if (!del.success) {
        return { ok: false, error: { code: 'REPOSITORY', message: del.error.message } };
      }

      return { ok: true, data: { deleted: true } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Delete conversation failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}

/**
 * 9) ExportConversationsUseCase
 */
export interface ExportConversationsInput {
  userId: string;
  conversationIds?: string[];
  includeMetadata?: boolean;
  format?: 'json' | 'csv';
}
export interface ExportConversationsOutput {
  data: string;
  filename: string;
  format: string;
}
export class ExportConversationsUseCase {
  constructor(
    private readonly conversationService: {
      exportConversations: (userId: string, options?: {
        conversationIds?: string[];
        includeMetadata?: boolean;
        format?: 'json' | 'csv';
      }) => Promise<{ data: string; filename: string; format: string }>;
    }
  ) {}

  async execute(input: ExportConversationsInput): Promise<UseCaseResult<ExportConversationsOutput>> {
    try {
      const exportData = await this.conversationService.exportConversations(input.userId, {
        conversationIds: input.conversationIds,
        includeMetadata: input.includeMetadata,
        format: input.format
      });

      return { ok: true, data: exportData };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Export conversations failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}

/**
 * 10) ImportConversationsUseCase
 */
export interface ImportConversationsInput {
  userId: string;
  data: string;
  mergeStrategy?: 'skip' | 'overwrite' | 'create_copy';
}
export interface ImportConversationsOutput {
  imported: number;
  skipped: number;
  conflicts: { conversation_id: string; reason: 'duplicate_name' | 'invalid_format' }[];
}
export class ImportConversationsUseCase {
  constructor(
    private readonly conversationService: {
      importConversations: (userId: string, options: {
        data: string;
        mergeStrategy?: 'skip' | 'overwrite' | 'create_copy';
      }) => Promise<{ imported: number; skipped: number; conflicts: Array<{ conversation_id: string; reason: 'duplicate_name' | 'invalid_format' }> }>;
    }
  ) {}

  async execute(input: ImportConversationsInput): Promise<UseCaseResult<ImportConversationsOutput>> {
    try {
      if (!input.data || input.data.trim().length === 0) {
        return { ok: false, error: { code: 'VALIDATION', message: 'data is required' } };
      }

      const result = await this.conversationService.importConversations(input.userId, {
        data: input.data,
        mergeStrategy: input.mergeStrategy
      });

      return { ok: true, data: result };
    } catch (e: unknown) {
      return { ok: false, error: { code: 'UNEXPECTED', message: e instanceof Error ? e.message : 'Import conversations failed' } };
    }
  }
}

/**
 * 11) UploadFileUseCase
 */
export interface UploadFileInput {
  userId: string;
  file: NonNullable<DomainFileUploadInput['file']>;
  conversationId?: string;
  processAsImages?: boolean;
}
export type UploadFileOutput = DomainFileUploadResult;

export class UploadFileUseCase {
  constructor(
    private readonly fileProcessingService: {
      processFileUpload: (input: DomainFileUploadInput, userId: string) => Promise<DomainFileUploadResult>;
    }
  ) {}

  async execute(input: UploadFileInput): Promise<UseCaseResult<UploadFileOutput>> {
    try {
      if (!input.file) {
        return { ok: false, error: { code: 'VALIDATION', message: 'file is required' } };
      }

      const domainInput: DomainFileUploadInput = {
        file: input.file,
        processAsImages: input.processAsImages,
      };

      const result = await this.fileProcessingService.processFileUpload(
        domainInput,
        input.userId
      );

      return { ok: true, data: result };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'File upload failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}