export type EventBusTransport = 'pubsub' | 'streams';

/** Empty and `pubsub` stay on Redis Pub/Sub. `streams` keeps entries until a consumer group acknowledges them. */
export function selectEventBusTransport(raw: string | undefined): EventBusTransport {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'pubsub') return 'pubsub';
  if (value === 'streams') return 'streams';
  throw new Error('EVENT_BUS_TRANSPORT must be pubsub or streams');
}
