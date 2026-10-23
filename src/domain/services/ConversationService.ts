/**
 * ConversationService — доменный сервис для работы с разговорами в BFF-контуре.
 * Layer: Domain
 *
 * Исторически был in-memory заглушкой с Map, что приводило к потере данных.
 * В рамках TASK‑008 сервис переведён на работу через IConversationRepository,
 * так что все данные хранятся в персистентном хранилище (PostgreSQL или in‑memory
 * реализация репозитория в тестах).
 */

import { Conversation } from '../conversation/Conversation';
import { ConversationId } from '../conversation/ConversationId';
import {
  IConversationRepository,
  InMemoryConversationRepository,
  RepositoryResult,
} from '../conversation/IConversationRepository';
import { safeJsonParse } from '../../core/utils/json';

type Metadata = Record<string, unknown> | null;

interface ConversationLike {
  id: string;
  name: string;
  created: string;
  lastModified: string;
  currNode: string | null;
  metadata?: Metadata;
}

interface ConversationsListLike {
  conversations: ConversationLike[];
  total: number;
}

interface ExportConversationsRequestLike {
  conversationIds?: string[];
  includeMetadata?: boolean;
  format?: 'json' | 'csv';
}

interface ImportConversationsRequestLike {
  data: string;
  mergeStrategy?: 'skip' | 'overwrite' | 'create_copy';
}

interface ExportConversationsResponseLike {
  data: string;
  filename: string;
  format: string;
}

interface ImportConversationsResponseLike {
  imported: number;
  skipped: number;
  conflicts: {
    conversation_id: string;
    reason: 'duplicate_name' | 'invalid_format';
  }[];
}

/**
 * Внутренний формат payload для exportConversations (backward‑compatible с старой заглушкой).
 */
interface ExportPayload {
  conversations: ConversationLike[];
  exportedAt: string;
}

/**
 * ConversationService использует только доменный репозиторий IConversationRepository
 * и не хранит состояние в процессе (нет Map / in‑memory storage).
 */
export class ConversationService {
  private readonly repository: IConversationRepository;

  constructor(repository?: IConversationRepository) {
    this.repository = repository ?? new InMemoryConversationRepository();
  }

  /**
   * Создать новый разговор и сохранить его через репозиторий.
   * Возвращает упрощённый DTO, совместимый с BFF.
   */
  async createConversation(
    userId: string,
    name?: string,
    metadata?: Metadata,
  ): Promise<ConversationLike> {
    const conversation = Conversation.create({
      createdBy: userId,
      title: name,
      participantIds: [userId],
      metadata: metadata === null ? undefined : metadata ?? undefined,
    });

    const saved = await this.repository.save(conversation);
    if (!saved.success) {
      throw saved.error;
    }

    return this.mapConversationToSummary(saved.data);
  }

  /**
   * Получить список разговоров для пользователя с простой пагинацией.
   * Использует IConversationRepository.find(..).
   */
  async getConversations(
    userId: string,
    opts: { page: number; limit: number },
  ): Promise<ConversationsListLike> {
    const page = opts.page > 0 ? opts.page : 1;
    const rawLimit = opts.limit > 0 ? opts.limit : 20;
    const limit = rawLimit > 100 ? 100 : rawLimit;
    const offset = (page - 1) * limit;

    const result = await this.repository.find({
      createdBy: userId,
      limit,
      offset,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });

    if (!result.success) {
      return {
        conversations: [],
        total: 0,
      };
    }

    const conversations = result.data.conversations.map((conversation) =>
      this.mapConversationToSummary(conversation),
    );

    return {
      conversations,
      total: result.data.total,
    };
  }

  /**
   * Получить один разговор, если пользователь имеет к нему доступ.
   */
  async getConversation(
    conversationId: string,
    userId: string,
  ): Promise<ConversationLike | null> {
    if (!ConversationId.isValid(conversationId)) {
      return null;
    }

    const id = ConversationId.fromString(conversationId);
    const result = await this.repository.findById(id);
    if (!result.success) {
      return null;
    }

    const conversation = result.data;

    // Простейшая авторизация: владелец или участник
    if (conversation.createdBy !== userId) {
      const isParticipant = conversation.participants.some((participant) => {
        return participant.id.toValue() === userId;
      });
      if (!isParticipant) {
        return null;
      }
    }

    return this.mapConversationToSummary(conversation);
  }

  /**
   * Обновление разговора через данный сервис на текущем этапе не используется
   * (основной путь — UpdateConversationUseCase). Метод оставлен для обратной
   * совместимости и возвращает null.
   */
   
  async updateConversation(
    conversationId: string,
    userId: string,
    req: { name?: string; metadata?: Metadata },
  ): Promise<ConversationLike | null> {
    return null;
  }

  /**
   * Удаление разговора через данный сервис на текущем этапе не используется
   * (основной путь — DeleteConversationUseCase). Метод оставлен для обратной
   * совместимости и делает soft‑delete через репозиторий, если разговор найден.
   */
  async deleteConversation(conversationId: string, userId: string): Promise<void> {
    if (!ConversationId.isValid(conversationId)) {
      return;
    }

    const id = ConversationId.fromString(conversationId);
    const existing = await this.repository.findById(id);
    if (!existing.success) {
      return;
    }

    const conversation = existing.data;
    if (conversation.createdBy !== userId) {
      return;
    }

    await this.repository.delete(id);
  }

  /**
   * Экспорт разговоров пользователя.
   *
   * Формат payload совместим с предыдущей in‑memory заглушкой:
   * {
   *   conversations: ConversationLike[];
   *   exportedAt: ISOString;
   * }
   *
   * Возвращаемое значение — base64‑строка с JSON.
   */
  async exportConversations(
    userId: string,
    request: ExportConversationsRequestLike,
  ): Promise<ExportConversationsResponseLike> {
    const requestedIds = request.conversationIds;
    let conversations: ConversationLike[] = [];

    if (requestedIds && requestedIds.length > 0) {
      const uniqueIds: string[] = [];
      for (const rawId of requestedIds) {
        if (uniqueIds.indexOf(rawId) === -1) {
          uniqueIds.push(rawId);
        }
      }

      const collected: ConversationLike[] = [];
      for (const rawId of uniqueIds) {
        if (!ConversationId.isValid(rawId)) {
          continue;
        }
        const id = ConversationId.fromString(rawId);
        const result = await this.repository.findById(id);
        if (!result.success) {
          continue;
        }
        const conversation = result.data;
        if (conversation.createdBy !== userId) {
          continue;
        }
        collected.push(this.mapConversationToSummary(conversation));
      }
      conversations = collected;
    } else {
      const total = await this.safeCountForUser(userId);
      if (total > 0) {
        const result = await this.repository.find({
          createdBy: userId,
          limit: total,
          offset: 0,
          sortBy: 'createdAt',
          sortOrder: 'asc',
        });
        if (result.success) {
          conversations = result.data.conversations.map((conversation) =>
            this.mapConversationToSummary(conversation),
          );
        }
      }
    }

    const payload: ExportPayload = {
      conversations,
      exportedAt: new Date().toISOString(),
    };

    const json = JSON.stringify(payload);
    const base64 = Buffer.from(json, 'utf-8').toString('base64');

    const format = request.format ?? 'json';
    const extension = format === 'csv' ? 'csv' : 'json';

    return {
      data: base64,
      filename: `conversations_export_${Date.now()}.${extension}`,
      format,
    };
  }

  /**
   * Импорт разговоров.
   *
   * На данном этапе импорт создаёт новые разговоры на основе переданных
   * ConversationLike и не восстанавливает дерево сообщений. Поведение
   * mergeStrategy упрощено: всегда создаются новые разговоры без перезаписи.
   */
  async importConversations(
    userId: string,
    request: ImportConversationsRequestLike,
  ): Promise<ImportConversationsResponseLike> {
    try {
      const json = Buffer.from(request.data, 'base64').toString('utf-8');
      const parsed = safeJsonParse<{ conversations?: unknown }>(json);

      if (!parsed || typeof parsed !== 'object') {
        return {
          imported: 0,
          skipped: 0,
          conflicts: [],
        };
      }

      const rawConversations = parsed.conversations;
      if (!Array.isArray(rawConversations)) {
        return {
          imported: 0,
          skipped: 0,
          conflicts: [],
        };
      }

      let imported = 0;
      let skipped = 0;
      const conflicts: ImportConversationsResponseLike['conflicts'] = [];

      for (const item of rawConversations) {
        const entry = item as { id?: unknown; name?: unknown; metadata?: unknown };
        if (typeof entry.id !== 'string') {
          skipped += 1;
          continue;
        }

        const nameValue =
          typeof entry.name === 'string' && entry.name.length > 0
            ? entry.name
            : 'Untitled conversation';

        const metadataValue =
          typeof entry.metadata === 'object' && entry.metadata !== null
            ? (entry.metadata as Metadata)
            : null;

        const conversation = Conversation.create({
          createdBy: userId,
          title: nameValue,
          metadata: metadataValue === null ? undefined : metadataValue ?? undefined,
        });

        const saveResult: RepositoryResult<Conversation> =
          await this.repository.save(conversation);

        if (!saveResult.success) {
          skipped += 1;
          conflicts.push({
            conversation_id: entry.id,
            reason: 'invalid_format',
          });
          continue;
        }

        imported += 1;
      }

      return {
        imported,
        skipped,
        conflicts,
      };
    } catch {
      return {
        imported: 0,
        skipped: 0,
        conflicts: [],
      };
    }
  }

  private mapConversationToSummary(conversation: Conversation): ConversationLike {
    const serialized = conversation.serialize();

    const title =
      typeof serialized.title === 'string' && serialized.title.trim().length > 0
        ? serialized.title
        : 'Untitled conversation';

    const created =
      typeof serialized.createdAt === 'string'
        ? serialized.createdAt
        : String(serialized.createdAt);

    const lastModified =
      typeof serialized.updatedAt === 'string'
        ? serialized.updatedAt
        : String(serialized.updatedAt);

    const metadata =
      typeof serialized.metadata === 'object' && serialized.metadata !== null
        ? (serialized.metadata as Metadata)
        : undefined;

    return {
      id: String(serialized.id),
      name: title,
      created,
      lastModified,
      currNode: null,
      metadata,
    };
  }

  private async safeCountForUser(userId: string): Promise<number> {
    try {
      return this.repository.count({ createdBy: userId });
    } catch {
      return 0;
    }
  }
}

export default ConversationService;