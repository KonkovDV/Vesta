/**
 * LegacySessionMemoryStore — фасад legacy-памяти для Session Memory (Phase 11 M1.5).
 *
 * Layer: Memory
 *
 * На текущем этапе TS-миграции полноценная legacy-session/semantic/working/procedural
 * память (Phase 5–7, pgvector и др.) живёт в отдельных артефактах и ещё не
 * интегрирована в общий DI-контур.
 *
 * Данный класс:
 * - реализует интерфейс SessionMemoryStore;
 * - делегирует операции во встроенный InMemorySessionMemoryStore;
 * - гарантирует идемпотентность createSessionRecord по паре
 *   { tenant_id, external_session_ref } за счёт внутренней логики
 *   InMemorySessionMemoryStore;
 * - НЕ имеет никакого доступа к HSG/Vector — только SessionContext.
 *
 * В будущих фазах (при переносе Phase 5–7 в TS) внутренняя реализация будет
 * заменена адаптером к реальным legacy-репозиториям (conversation storage,
 * semantic/working/procedural memory).
 */

import type {
  SessionMemoryStore,
} from '../../domain/memory/session-memory-ports';
import type {
  SessionConfig,
  SessionContext,
  SessionId,
  SessionMetadata,
  TenantId,
  UserId,
} from '../../domain/memory/session-types';
import { InMemorySessionMemoryStore } from '../session/SessionMemoryManager';

export class LegacySessionMemoryStore implements SessionMemoryStore {
  private readonly inner: InMemorySessionMemoryStore;

  constructor(inner?: InMemorySessionMemoryStore) {
    // Позволяем внедрять существующий in-memory store в тестах, но по умолчанию
    // создаём отдельный экземпляр, отражая отдельный legacy-путь.
    this.inner = inner ?? new InMemorySessionMemoryStore();
  }

  async createSessionRecord(input: {
    tenant_id: TenantId;
    user_id: UserId;
    external_session_ref?: string;
    initial_context?: Record<string, unknown>;
    config_override?: Partial<SessionConfig>;
  }): Promise<{
    session: SessionContext;
    created: boolean;
    loaded_working_memory: number;
  }> {
    // Идемпотентность по {tenant_id, external_session_ref} обеспечивается
    // реализацией InMemorySessionMemoryStore.resolveSessionId().
    return this.inner.createSessionRecord(input);
  }

  async loadSession(tenant_id: TenantId, session_id: SessionId): Promise<SessionContext | null> {
    return this.inner.loadSession(tenant_id, session_id);
  }

  async saveSession(context: SessionContext): Promise<void> {
    return this.inner.saveSession(context);
  }

  async archiveSession(tenant_id: TenantId, session_id: SessionId): Promise<void> {
    return this.inner.archiveSession(tenant_id, session_id);
  }

  async getSessionMetadata(tenant_id: TenantId, session_id: SessionId): Promise<SessionMetadata | null> {
    return this.inner.getSessionMetadata(tenant_id, session_id);
  }
}