# ADR-0004: A durable event bus by default

- **Status:** Accepted
- **Date:** 2026-11-04
- **Related:** ADR-0002 (invariant 3: delivery is at least once), MP-K22, claim C5

## Context

The outbox hands each row to the bus at least once (C5). Until 3.0.0 the default bus was Redis Pub/Sub. `PUBLISH` keeps nothing: the outbox marks a row PUBLISHED when Redis accepts it, also when no subscriber is connected, and the event never reaches a consumer that is down or restarting. So the guarantee stopped at Redis (MP-K22). 2.13.0 added `EVENT_BUS_TRANSPORT=streams` and kept Pub/Sub as the default.

Redis documents Pub/Sub as fire-and-forget and Streams with consumer groups as the at-least-once option. An entry that a consumer read and did not acknowledge stays in the group's pending list, and a sweep with `XAUTOCLAIM` hands it to a live consumer. The usual shape of a transactional outbox is the same: a relay that delivers at least once, and a consumer that skips an id it already finished (an inbox table; here `processed_events`).

Two Redis releases close the remaining gaps of a stream used this way:

- Redis 8.2 added `ACKED` to `XADD` and `XTRIM`: trimming to `MAXLEN` removes only entries that every consumer group read and acknowledged. Without it, `MAXLEN ~ N` drops the oldest entries even when a group has not read them. Checked on Redis 8.10.3: a group that read nothing kept 100 of 400 entries with `MAXLEN ~ 10`, and all 400 with `ACKED MAXLEN ~ 10`.
- Redis 8.6 added `IDMP producer-id idempotent-id` to `XADD`: a second add with the same pair returns the first entry. That is the outbox retry after a crash between `XADD` and the published mark. Redis keeps the last 100 ids for 100 s per producer and stream by default.

## Decision

1. From 3.0.0 an empty `EVENT_BUS_TRANSPORT` selects Redis Streams. `pubsub` must be set explicitly.
2. The streams bus reads `redis_version` from `INFO` when it connects. From 8.2 it trims with `ACKED`. From 8.6 it adds each event with `IDMP <prefix>events <eventId>`. A dead-letter replay is added without `IDMP`, because it is a new delivery. Older servers, and forks that report an older version (Valkey reports 7.2.x), get neither option.
3. `processed_events` stays the guarantee on the consumer side. `IDMP` only removes most duplicates at the source.

## Consequences

- A process that subscribed to the kernel's Pub/Sub channels from outside receives nothing after the upgrade. It joins a consumer group on `<prefix>stream:<eventType>`, or the deployment sets `EVENT_BUS_TRANSPORT=pubsub`. That is why this is a major version.
- On Redis older than 8.2 a group that falls more than `EVENT_BUS_STREAM_MAXLEN` entries behind (default 10 000 per event type) still loses the oldest entries. The journal keeps every event; `getCommittedEventsAfter` rebuilds such a consumer.
- With `ACKED`, a group that stops reading makes its stream grow past `MAXLEN` until it catches up or the group is deleted. Watch `XINFO GROUPS` lag and the stream length.
- Streams need `DATABASE_URL` for `processed_events`. Without it a handler can run twice for one event.
- CI runs the integration job on `redis:7-alpine` and `redis:8.10-alpine`, so both paths stay tested.

## Sources

- Redis, `XADD` command reference: `KEEPREF | DELREF | ACKED` (since 8.2), `IDMP | IDMPAUTO` (since 8.6). https://redis.io/docs/latest/commands/xadd/
- Redis, Idempotent message processing (defaults of `IDMP-DURATION` and `IDMP-MAXSIZE`). https://redis.io/docs/latest/develop/data-types/streams/idempotency/
- Redis, Streaming use case: at-least-once with `XREADGROUP`/`XACK`, the pending list, an `XAUTOCLAIM` sweep, a trim policy. https://redis.io/docs/latest/develop/use-cases/streaming/
- OneUptime, How to choose between Pub/Sub and Streams in Redis (2026-01-25). https://oneuptime.com/blog/post/2026-01-25-redis-pubsub-vs-streams/markdown
- Conduktor, Outbox pattern for reliable event publishing (relay at least once, idempotent consumer). https://www.conduktor.io/glossary/outbox-pattern-for-reliable-event-publishing
