/**
 * Content Scanner port for PII/sensitivity detection in Memory layer.
 *
 * Layer: Domain
 *
 * This port defines a contract for scanning content before it's stored
 * in memory, allowing governance layer to detect and potentially redact
 * PII, confidential data, or otherwise sensitive content.
 *
 * MVP implementation uses stub scanner that always allows content.
 * Production can plug in Presidio, Google DLP, or custom ML models.
 */

import type {
  CorrelationId,
  SessionId,
  TenantId,
  UserId,
} from '../session-types';

/**
 * Detected sensitivity level.
 */
export type ContentSensitivity =
  | 'public'        // No sensitive data detected
  | 'internal'      // Internal references, metadata
  | 'confidential'  // Business-sensitive data
  | 'pii'           // Personal identifiable information
  | 'restricted';   // Highly sensitive, may require redaction

/**
 * Detected entity in scanned content.
 */
export interface DetectedEntity {
  /** Type of entity (e.g., 'email', 'phone', 'ssn', 'credit_card') */
  entity_type: string;
  /** Byte offset in the original content */
  start: number;
  /** Byte offset end in the original content */
  end: number;
  /** Confidence score 0-1 */
  confidence: number;
  /** Suggested redaction (e.g., '[EMAIL]', '[PHONE]') */
  redaction?: string;
}

/**
 * Result of content scanning.
 */
export interface ContentScanResult {
  /** Is content allowed to be stored? */
  allowed: boolean;
  /** Detected sensitivity level */
  sensitivity: ContentSensitivity;
  /** List of detected entities */
  detected_entities: DetectedEntity[];
  /** Redacted content (if redaction was requested and entities found) */
  redacted_content?: string;
  /** Scan execution time in milliseconds */
  scan_duration_ms: number;
  /** Scanner version/model identifier */
  scanner_version: string;
}

/**
 * Input for content scanning.
 */
export interface ContentScanInput {
  tenant_id: TenantId;
  user_id?: UserId;
  session_id?: SessionId;
  /** The content to scan */
  content: string;
  /** Content type hint (e.g., 'text/plain', 'application/json') */
  content_type?: string;
  /** Whether to perform redaction on detected entities */
  redact?: boolean;
  /** Sensitivity threshold - reject if detected level >= threshold */
  reject_above?: ContentSensitivity;
  /** Correlation ID for tracing */
  correlation_id: CorrelationId;
}

/**
 * Content scanner port for Memory governance.
 *
 * Implementations:
 * - StubContentScanner: MVP, always allows content
 * - PresidioContentScanner: Integration with Presidio anonymizer
 * - DLPContentScanner: Integration with Google DLP
 */
export interface IContentScanner {
  /**
   * Scan content for sensitive data.
   *
   * @returns Scan result with sensitivity level and detected entities
   */
  scan(input: ContentScanInput): Promise<ContentScanResult>;
}

/**
 * Stub content scanner that always allows content.
 *
 * Use this for development and when no scanner is configured.
 */
export class StubContentScanner implements IContentScanner {
  async scan(input: ContentScanInput): Promise<ContentScanResult> {
    const start = Date.now();
    return {
      allowed: true,
      sensitivity: 'public',
      detected_entities: [],
      scan_duration_ms: Date.now() - start,
      scanner_version: 'stub-v1.0.0',
    };
  }
}

/**
 * DI token for IContentScanner.
 */
export const CONTENT_SCANNER_TOKEN = 'IContentScanner' as const;
