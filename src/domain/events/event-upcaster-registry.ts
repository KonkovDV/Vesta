import type { DomainEvent } from './event-store.interface';

/**
 * Upcaster function transforms event payload from one schema version to another.
 * Works only with plain JSON-compatible payloads.
 */
export type EventUpcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

interface UpcasterEntry {
  readonly toVersion: number;
  readonly upcaster: EventUpcaster;
}

const upcasters = new Map<string, UpcasterEntry>();

function makeKey(eventType: string, fromVersion: number): string {
  return `${eventType}::${fromVersion}`;
}

/**
 * Register upcaster for particular event type and schema version.
 * New registration for the same (eventType, fromVersion) pair overwrites previous one.
 */
export function registerEventUpcaster(
  eventType: string,
  fromVersion: number,
  toVersion: number,
  upcaster: EventUpcaster,
): void {
  if (!eventType) {
    return;
  }

  if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion)) {
    return;
  }

  if (toVersion <= fromVersion) {
    return;
  }

  const key = makeKey(eventType, fromVersion);
  upcasters.set(key, { toVersion, upcaster });
}

export function getEventUpcaster(eventType: string, fromVersion: number): EventUpcaster | undefined {
  const entry = upcasters.get(makeKey(eventType, fromVersion));
  return entry?.upcaster;
}

/**
 * Returns target schema version that this upcaster moves to, if registered.
 */
export function getNextSchemaVersion(eventType: string, fromVersion: number): number | undefined {
  const entry = upcasters.get(makeKey(eventType, fromVersion));
  if (!entry) {
    return undefined;
  }
  return entry.toVersion;
}

/**
 * Apply all registered upcasters to given DomainEvent, producing event in latest known schema.
 * If no upcasters registered for event type, original event is returned.
 */
export function applyEventUpcasters(event: DomainEvent): DomainEvent {
  const currentSchemaVersion =
    typeof event.schemaVersion === 'number' && event.schemaVersion > 0 ? event.schemaVersion : 1;

  let version = currentSchemaVersion;
  let payload: Record<string, unknown> = event.payload;

  let steps = 0;
  const maxSteps = 32;

  while (steps < maxSteps) {
    const entry = upcasters.get(makeKey(event.type, version));
    if (!entry) {
      break;
    }

    payload = entry.upcaster(payload);
    version = entry.toVersion;
    steps += 1;
  }

  if (version === currentSchemaVersion && payload === event.payload) {
    return event;
  }

  return {
    ...event,
    schemaVersion: version,
    payload,
  };
}

/**
 * Utility helper for bulk upcasting.
 */
export function applyEventUpcastersToArray(events: DomainEvent[]): DomainEvent[] {
  if (events.length === 0) {
    return events;
  }
  return events.map((event) => applyEventUpcasters(event));
}

/**
 * Clear registry. Intended for tests only.
 */
export function clearEventUpcasters(): void {
  upcasters.clear();
}