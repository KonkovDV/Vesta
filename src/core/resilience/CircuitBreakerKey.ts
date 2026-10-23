/**
 * Core key type for identifying a circuit breaker instance.
 * Layer: Core/Resilience.
 *
 * Used by ICircuitBreakerRegistry/Factory and AOP aspects to ensure that
 * all callers referring to the same "resource" share the same breaker.
 */

export type CircuitBreakerChannel =
  | 'LLM'
  | 'HTTP'
  | 'EVENT_BUS'
  | 'DB'
  | 'MEMORY'
  | 'CACHE'
  | 'OTHER';

export interface CircuitBreakerKey {
  channel: CircuitBreakerChannel;
  serviceName: string;
  operation: string;
  tenantId?: string;
  environment: string;
  extraTags?: Record<string, string>;
}

function escape(value: string | undefined | null): string {
  if (value == null) {
    return 'unknown';
  }
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/=/g, '\\=');
}

/**
 * Deterministically serialize CircuitBreakerKey to a string usable as a Map key
 * and for metrics labels.
 */
export function serializeCircuitBreakerKey(key: CircuitBreakerKey): string {
  const parts: string[] = [];

  parts.push(`ch=${escape(key.channel)}`);
  parts.push(`svc=${escape(key.serviceName)}`);
  parts.push(`op=${escape(key.operation)}`);
  parts.push(`env=${escape(key.environment)}`);

  if (key.tenantId) {
    parts.push(`tenant=${escape(key.tenantId)}`);
  }

  if (key.extraTags && Object.keys(key.extraTags).length > 0) {
    const sortedEntries = Object.entries(key.extraTags).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [tagKey, tagValue] of sortedEntries) {
      parts.push(`tag:${escape(tagKey)}=${escape(tagValue)}`);
    }
  }

  return parts.join('|');
}

export function getMetricsLabelsFromKey(
  key: CircuitBreakerKey,
): Record<string, string> {
  const labels: Record<string, string> = {
    channel: key.channel,
    service: key.serviceName,
    operation: key.operation,
    environment: key.environment,
  };

  if (key.tenantId) {
    labels.tenant = key.tenantId;
  }

  if (key.extraTags) {
    for (const [k, v] of Object.entries(key.extraTags)) {
      const safeKey = `tag_${k}`.replace(/[^a-zA-Z0-9_]/g, '_');
      labels[safeKey] = String(v);
    }
  }

  return labels;
}