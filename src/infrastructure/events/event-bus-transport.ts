export type EventBusTransport = 'pubsub' | 'streams';

/**
 * Empty and `streams` use Redis Streams: an entry stays until a consumer group
 * acknowledges it (ADR-0004). `pubsub` must be asked for: a publish that reaches
 * no subscriber is gone.
 */
export function selectEventBusTransport(raw: string | undefined): EventBusTransport {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'streams') return 'streams';
  if (value === 'pubsub') return 'pubsub';
  throw new Error('EVENT_BUS_TRANSPORT must be streams or pubsub');
}
