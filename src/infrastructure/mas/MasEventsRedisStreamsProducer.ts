import type { IEventBus, EventHandler } from '../../domain/events/event-bus.interface';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import { MasRedisStreamsClient } from './MasRedisStreamsClient';
import { MAS_EVENT_TOPICS } from '../../domain/mas/mas-event-topics';

const MAS_STREAM_EVENT_TYPES: string[] = (
  MAS_EVENT_TOPICS as readonly string[]
).filter((t) => t.startsWith('mas.session.') || t.startsWith('mas.task.'));

/**
 * R2.3 MAS Events → Redis Streams producer.
 *
 * Layer: Infrastructure (events/MAS observability).
 *
 * Listens to MAS session/task events on IEventBus (Outbox-first pipeline) and
 * mirrors them into Redis Streams `mas:events` in a denormalised form
 * suitable for CQRS projectors and analytics.
 */
export class MasEventsRedisStreamsProducer {
  private readonly eventBus: IEventBus;
  private readonly streamsClient: MasRedisStreamsClient;
  private initialized = false;
  private subscriptions: string[] = [];

  constructor(eventBus: IEventBus, streamsClient: MasRedisStreamsClient) {
    this.eventBus = eventBus;
    this.streamsClient = streamsClient;
  }

  /**
   * Idempotent initialization:
   * - ensures EventBus is initialized;
   * - subscribes to MAS session/task event types.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Ensure underlying bus is ready (RedisEventBus.initialize is idempotent).
    await this.eventBus.initialize();

    const handler: EventHandler<DomainEvent> = async (event) => {
      await this.handleMasEvent(event);
    };

    for (const eventType of MAS_STREAM_EVENT_TYPES) {
      const subscriptionId = await this.eventBus.subscribe(eventType, handler, {
        priority: 'NORMAL',
        maxRetries: 0,
        enableDeadLetterQueue: false,
      });
      this.subscriptions.push(subscriptionId);
    }

    this.initialized = true;
  }

  private async handleMasEvent(event: DomainEvent): Promise<void> {
    if (!event.type.startsWith('mas.session.') && !event.type.startsWith('mas.task.')) {
      return;
    }

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const metadata = (event.metadata ?? {}) as Record<string, unknown>;

    const masSessionId = this.asNonEmptyString(payload.mas_session_id);
    const taskId = this.asNonEmptyString((payload as { task_id?: unknown }).task_id);
    const tenantId = this.asNonEmptyString((payload as { tenant_id?: unknown }).tenant_id);
    const scenario = this.asNonEmptyString((payload as { scenario?: unknown }).scenario);
    const useCase = this.asNonEmptyString((payload as { use_case?: unknown }).use_case);
    const correlationIdFromPayload = this.asNonEmptyString(
      (payload as { correlation_id?: unknown }).correlation_id,
    );

    const correlationId =
      correlationIdFromPayload || this.asNonEmptyString(event.correlationId) || '';

    const correlationSource = this.asNonEmptyString(
      (payload as { correlation_source?: unknown }).correlation_source,
    );

    const fields: Record<string, string> = {
      event_id: event.eventId,
      event_type: event.type,
      aggregate_id: event.aggregateId,
      aggregate_version: String(event.aggregateVersion),
      timestamp: event.timestamp.toISOString(),
      correlation_id: correlationId,
    };

    if (correlationSource) {
      fields.correlation_source = correlationSource;
    }

    if (masSessionId) {
      fields.mas_session_id = masSessionId;
      // For downstream tools that expect generic `session_id` field:
      fields.session_id = masSessionId;
    }

    if (taskId) {
      fields.task_id = taskId;
    }

    if (tenantId) {
      fields.tenant_id = tenantId;
    }

    if (scenario) {
      fields.scenario = scenario;
    }

    if (useCase) {
      fields.use_case = useCase;
    }

    fields.payload = JSON.stringify(payload);

    if (metadata && Object.keys(metadata).length > 0) {
      fields.metadata = JSON.stringify(metadata);
    }

    await this.streamsClient.append(fields, event.eventId);
  }

  private asNonEmptyString(value: unknown): string {
    if (value == null) {
      return '';
    }
    const s = String(value).trim();
    return s.length > 0 ? s : '';
  }

  async close(): Promise<void> {
    // No-op: subscriptions live on the shared IEventBus instance.
    // Provided for symmetry with other DI-managed services.
    for (const id of this.subscriptions) {
      try {
        await this.eventBus.unsubscribe(id);
      } catch {
        // best-effort
      }
    }
    this.subscriptions = [];
    this.initialized = false;
  }
}