/**
 * Content Scan Metrics for Memory Governance (MEM-NEXT.1).
 *
 * Layer: Monitoring
 *
 * Provides Prometheus metrics for:
 * - Scan duration (histogram)
 * - Scan results (counter by sensitivity/allowed)
 * - Blocked content (counter)
 * - Detected entities (counter by type)
 */

import { getOrCreateCounter, getOrCreateHistogram } from './registry';
import type { ContentSensitivity } from '../domain/memory/governance/content-scanner';

const contentScanDurationHistogram = getOrCreateHistogram(
  'memory_content_scan_duration_seconds',
  'Duration of content scanning operations',
  ['scanner', 'sensitivity', 'allowed'],
);

const contentScanTotalCounter = getOrCreateCounter(
  'memory_content_scan_total',
  'Total number of content scan operations',
  ['scanner', 'sensitivity', 'allowed'],
);

const contentScanBlockedCounter = getOrCreateCounter(
  'memory_content_scan_blocked_total',
  'Total number of blocked content due to sensitivity',
  ['sensitivity', 'reason'],
);

const contentScanEntitiesCounter = getOrCreateCounter(
  'memory_content_scan_entities_detected_total',
  'Total number of detected entities by type',
  ['entity_type', 'scanner'],
);

const contentScanRedactedCounter = getOrCreateCounter(
  'memory_content_scan_redacted_total',
  'Total number of messages with redacted content',
  ['scanner'],
);

const contentScanErrorsCounter = getOrCreateCounter(
  'memory_content_scan_errors_total',
  'Total number of content scan errors',
  ['scanner', 'error_class'],
);

function classifyScanError(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const lower = message.toLowerCase();

    if (lower.includes('timeout') || lower.includes('etimedout')) {
      return 'timeout';
    }
    if (
      lower.includes('unavailable') ||
      lower.includes('econnrefused') ||
      lower.includes('econnreset')
    ) {
      return 'unavailable';
    }
    if (lower.includes('parse') || lower.includes('json')) {
      return 'parse_error';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function recordContentScanDuration(params: {
  scanner: string;
  sensitivity: ContentSensitivity;
  allowed: boolean;
  durationSeconds: number;
}): void {
  try {
    contentScanDurationHistogram.observe(
      {
        scanner: params.scanner,
        sensitivity: params.sensitivity,
        allowed: String(params.allowed),
      },
      params.durationSeconds,
    );

    contentScanTotalCounter.inc({
      scanner: params.scanner,
      sensitivity: params.sensitivity,
      allowed: String(params.allowed),
    });
  } catch {
    // Metrics must never break scanning logic.
  }
}

export function incrementContentScanBlocked(params: {
  sensitivity: ContentSensitivity;
  reason?: string;
}): void {
  try {
    contentScanBlockedCounter.inc({
      sensitivity: params.sensitivity,
      reason: params.reason ?? 'threshold_exceeded',
    });
  } catch {
    // Ignore metric errors.
  }
}

export function incrementContentScanEntities(params: {
  entityType: string;
  scanner: string;
  count?: number;
}): void {
  try {
    contentScanEntitiesCounter.inc(
      {
        entity_type: params.entityType,
        scanner: params.scanner,
      },
      params.count ?? 1,
    );
  } catch {
    // Ignore metric errors.
  }
}

export function incrementContentScanRedacted(params: {
  scanner: string;
}): void {
  try {
    contentScanRedactedCounter.inc({
      scanner: params.scanner,
    });
  } catch {
    // Ignore metric errors.
  }
}

export function recordContentScanError(params: {
  scanner: string;
  error: unknown;
}): void {
  try {
    const errorClass = classifyScanError(params.error);
    contentScanErrorsCounter.inc({
      scanner: params.scanner,
      error_class: errorClass,
    });
  } catch {
    // Ignore metric errors.
  }
}
