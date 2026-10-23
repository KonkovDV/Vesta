/**
 * Start the outbox worker only after the event bus has connected.
 * Layer: Infrastructure
 *
 * Publishing before IEventBus.initialize() throws and the worker
 * moves the message to the DLQ.
 */

import type { IEventBus } from '../../domain/events/event-bus.interface';
import type { IOutbox } from '../../domain/events/outbox.interface';

export async function startOutboxWhenBusReady(
  eventBus: Pick<IEventBus, 'initialize'>,
  outbox: Pick<IOutbox, 'startProcessing'>,
): Promise<void> {
  await eventBus.initialize();
  await outbox.startProcessing();
}
