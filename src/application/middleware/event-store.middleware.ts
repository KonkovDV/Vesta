/**
 * Event Store Middleware
 * Layer: Application
 *
 * Назначение:
 * - HTTP-путь публикации доменных событий через Express middleware.
 * - Диагностика и очистка RequestContext.pending_events в конце HTTP-запроса.
 *
 * Поддерживаемые паттерны доставки событий до EventStoreService:
 * 1) HTTP-flow через middleware:
 *    - контроллеры/хендлеры вызывают pushPendingEvent() для каждого DomainEvent;
 *    - события накапливаются в res.locals.__pendingDomainEvents и зеркалируются в RequestContext.metadata.pending_events;
 *    - при завершении ответа middleware читает этот буфер и вызывает EventStoreService.saveDomainEvents().
 * 2) Прямой путь EventStore:
 *    - прикладной код (MAS/MEM/internal use-cases, CLI/cron) может вызывать EventStoreService.saveDomainEvents() напрямую, минуя pushPendingEvent;
 *    - в не-HTTP сценариях это единственный путь; в HTTP-сценариях middleware остаётся диагностическим слоем и чистит RequestContext.pending_events.
 *
 * RCTX-очередь (RequestContext.metadata.pending_events):
 * - служит вспомогательным буфером и источником диагностики по HTTP-запросу;
 * - не является единственным источником истины: канонический слой гарантированной доставки — EventStoreService + Outbox/Event Store;
 * - наличие событий в pending_events не гарантирует их автоматическое сохранение без вызова EventStoreService.
 */

import { RequestContext } from '../context/request-context';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import type { EventStoreService } from '../services/EventStoreService';
import { readStr } from '../../core/config/app-config';

interface PendingEventsContainer {
  __pendingDomainEvents?: DomainEvent[];
}

type LocalsWithEvents = {
  locals: PendingEventsContainer;
};

export function uniqueByEventId(events: DomainEvent[]): DomainEvent[] {
  const seen = new Set<string>();
  const res: DomainEvent[] = [];
  for (const e of events) {
    if (e?.eventId && !seen.has(e.eventId)) {
      seen.add(e.eventId);
      res.push(e);
    }
  }
  return res;
}

function isProductionEnv(): boolean {
  const nodeEnv = (readStr('NODE_ENV', '') ?? '').toLowerCase();
  const bffEnv = (readStr('BFF_ENV', '') ?? '').toLowerCase();
  return nodeEnv === 'production' || bffEnv === 'production';
}

/**
 * Вспомогательный утилити-хелпер для контроллеров
 * Позволяет аккумулировать события в рамках текущего HTTP-запроса.
 */
export function pushPendingEvent(res: unknown, event: DomainEvent): void {
  // Проверяем, что res имеет нужную структуру
  if (!res || typeof res !== 'object') {
    throw new Error('Invalid response object');
  }
  
  const r = res as LocalsWithEvents;
  if (!r.locals) {
    r.locals = {};
  }
  
  if (!Array.isArray(r.locals.__pendingDomainEvents)) {
    r.locals.__pendingDomainEvents = [];
  }
  r.locals.__pendingDomainEvents.push(event);

  // Синхронизируем с RequestContext: общий буфер/диагностика для HTTP-флоу и других middleware/слоёв.
  try {
    for (const ev of r.locals.__pendingDomainEvents) {
      RequestContext.addPendingEvent(ev);
    }
  } catch {
    // Если RequestContext не инициализирован — это допустимо для не-HTTP контекстов
  }
}

/**
 * Основное middleware: сохраняет все накопленные события после завершения ответа.
 */
export function createEventStoreMiddleware(eventStoreService: EventStoreService) {
  return function eventStoreMiddleware(_req: unknown, res: unknown, next: () => void): void {
    // Проверяем, что res имеет нужную структуру
    if (!res || typeof res !== 'object') {
      next();
      return;
    }
    
    const response = res as { on?: (event: string, listener: () => void) => void } & LocalsWithEvents;
    
    // Зарегистрируем обработчик на завершение ответа
    if (typeof response.on === 'function') {
      response.on('finish', async () => {
        // Основной источник событий для этого middleware — res.locals
        const locals = response.locals;
        const events = Array.isArray(locals?.__pendingDomainEvents) ? locals.__pendingDomainEvents : [];

        // 🎯 ДИАГНОСТИКА: Проверка инварианта RequestContext
        const hasRequestContext = RequestContext.isInitialized();
        const contextEvents = hasRequestContext ? RequestContext.getPendingEvents() : [];

        const isProd = isProductionEnv();

        // В production не шумим; в non-prod диагностика доступна через RequestContext.metadata.

        if (events.length === 0) return;

        try {
          await eventStoreService.saveDomainEvents(events);
        } catch {
          // Ошибки сохранения событий логируются и обрабатываются на уровне EventStoreService/infra.
        } finally {
          // Очищаем RequestContext после обработки событий (устраняем memory leak)
          try {
            RequestContext.clearPendingEvents();
          } catch {
            // Если контекст не инициализирован - это нормально
          }
        }
      });
    }

    next();
  };
}

export default {
  createEventStoreMiddleware,
  pushPendingEvent,
};