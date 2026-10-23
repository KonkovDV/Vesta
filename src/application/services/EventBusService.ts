/**
 * EventBusService - Application Layer фасад поверх IEventBus
 * Layer: Application
 *
 * Назначение:
 * - Централизованная публикация доменных событий из Application слоя
 * - Обогащение/нормализация correlationId через RequestContext и CorrelationIdProvider
 * - Безопасная интеграция с Outbox (если Outbox зарегистрирован в DI — делаем no-op публикацию,
 *   чтобы избежать дублей: публикацией займется Outbox worker)
 *
 * Контракт (синхронизирован с AGENTS.md и SSOT):
 * - Для надежных доменных/внешних событий используем persist-then-publish через Outbox:
 *   - см. reliablePublishDomainEvents(...)
 * - Прямой publish в IEventBus допустим только:
 *   - для некритичных внутренних событий,
 *   - для тестов и вспомогательных сценариев,
 *   - явно помеченных fastPublish* вызовов.
 * - Если Outbox зарегистрирован в DI, надежный путь обязан идти через него.
 */

import { RequestContext } from '../context/request-context';
import { CorrelationIdProvider } from '../../core/correlation/correlation';
import { DomainEvent } from '../../domain/events/event-store.interface';
import { IEventBus } from '../../domain/events/event-bus.interface';
import { IOutbox } from '../../domain/events/outbox.interface';

export class EventBusService {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly outbox?: Pick<IOutbox, 'saveEventsWithOutbox'>
  ) {}

  /**
   * Надежная публикация списка доменных событий (persist-then-publish через Outbox).
   *
   * Инварианты:
   * - Если Outbox доступен:
   *   - сохраняем события через IOutbox.saveEventsWithOutbox (persist-then-publish),
   *   - EventBus публикацией занимается воркер/инфраструктура (здесь publish в IEventBus не вызывается),
   *   - нарушение этого контракта считается архитектурной ошибкой.
   * - Если Outbox недоступен:
   *   - допускается fallback: прямой publishBatch в IEventBus как деградированный режим,
   *   - рекомендуется использовать только в dev/test/внутренних сценариях.
   */
  async reliablePublishDomainEvents(events: DomainEvent[]): Promise<void> {
    if (!Array.isArray(events) || events.length === 0) return;

    const enriched = events.map((e) => this.enrichCorrelationId(e));

    const outbox = this.outbox;
    if (outbox) {
      await outbox.saveEventsWithOutbox(enriched);
      return;
    }

    // Fallback: нет Outbox → прямой publishBatch (логируем через RequestContext-aware трассировку выше по стеку)
    await this.eventBus.publishBatch(enriched);
  }

  /**
   * Быстрая (ненадежная) публикация одного события напрямую в IEventBus.
   * Использовать только для:
   * - внутренних, некритичных событий,
   * - тестов и утилит,
   * - случаев, явно допускаемых SSOT.
   */
  async fastPublishDomainEvent(event: DomainEvent): Promise<void> {
    if (!event) return;
    const enriched = this.enrichCorrelationId(event);
    await this.eventBus.publish(enriched);
  }

  /**
   * Быстрая (ненадежная) публикация нескольких событий напрямую в IEventBus.
   * Аналогично fastPublishDomainEvent, только batch.
   */
  async fastPublishDomainEvents(events: DomainEvent[]): Promise<void> {
    if (!Array.isArray(events) || events.length === 0) return;
    const enriched = events.map((e) => this.enrichCorrelationId(e));
    await this.eventBus.publishBatch(enriched);
  }

  /**
   * Прокси подписки на события
   */
  async subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void> | void): Promise<string> {
    return this.eventBus.subscribe(eventType, handler);
  }

  /**
   * Проверка здоровья шины событий
   */
  async isHealthy(): Promise<boolean> {
    return this.eventBus.isHealthy();
  }

  /**
   * Признак наличия Outbox в DI (сохранено при создании сервиса)
   */
  /**
   * Обогащение/нормализация correlationId:
   * 1) Если в событии валидный correlationId — оставляем
   * 2) Иначе берем из RequestContext (если доступен)
   * 3) Иначе генерируем через CorrelationIdProvider
   */
  private enrichCorrelationId(event: DomainEvent): DomainEvent {
    let ctxCorrelation: string | undefined;
    try {
      ctxCorrelation = RequestContext.getCorrelationId();
    } catch {
      ctxCorrelation = undefined;
    }

    const chosen = event.correlationId ?? ctxCorrelation;
    const normalized = CorrelationIdProvider.normalize(chosen);

    if (normalized && normalized !== event.correlationId) {
      return { ...event, correlationId: normalized };
    }
    return event;
  }
}
