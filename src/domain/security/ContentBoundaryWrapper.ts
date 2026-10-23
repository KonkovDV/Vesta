/**
 * ContentBoundaryWrapper — Randomized boundary markers for prompt injection prevention.
 *
 * Wraps untrusted external content (tool output, fetched URLs, file contents)
 * with randomized boundary IDs to prevent indirect prompt injection.
 *
 * The randomized boundary makes it impossible for attackers to predict
 * and prematurely close the content boundary tag.
 *
 * @layer Domain
 * @phase 16 — Content Security Hardening (OpenClaw extraction)
 * @donor external/openclaw/src/security/external-content.ts (293L)
 * @owasp LLM01 (Prompt Injection) — Layer 2: boundary isolation
 * @see PLANS/04_BACKLOG/OPENCLAW_EXTRACTION_PLAN_V1.md — Phase 16
 */

import { SecurityError } from '../errors/DomainError';
import { IdGenerator } from '../../core/utils/IdGenerator';

// ─── Error Types ─────────────────────────────────────────────────────────────

/**
 * Error thrown when boundary wrapping detects a security issue.
 */
export class ContentBoundaryError extends SecurityError {
  constructor(
    message: string,
    options?: { correlationId?: string; metadata?: Record<string, unknown> },
  ) {
    super(`Content boundary error: ${message}`, {
      correlationId: options?.correlationId,
      metadata: options?.metadata,
    });
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Source classification for external content.
 */
export type ContentSource =
  | 'url'
  | 'file'
  | 'tool_output'
  | 'user_upload'
  | 'api_response'
  | 'plugin'
  | 'clipboard'
  | 'unknown';

/**
 * Options for content wrapping.
 */
export interface WrapOptions {
  /** Source label for attribution */
  source: ContentSource;
  /** Optional human-readable label */
  label?: string;
  /** Maximum content length before truncation (default: 100_000) */
  maxLength?: number;
  /** Whether to strip potential boundary-closing attempts (default: true) */
  sanitize?: boolean;
}

/**
 * Result of content wrapping.
 */
export interface WrappedContent {
  /** The wrapped content string with boundary markers */
  readonly content: string;
  /** The boundary ID used (for validation/logging) */
  readonly boundaryId: string;
  /** Whether content was truncated */
  readonly truncated: boolean;
  /** Original content length */
  readonly originalLength: number;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * Domain contract for content boundary wrapping.
 */
export interface IContentBoundaryWrapper {
  /**
   * Wrap external content with randomized boundary markers.
   *
   * @param content - Raw untrusted content
   * @param options - Wrapping options (source, label, etc.)
   * @returns Wrapped content with boundary markers
   */
  wrap(content: string, options: WrapOptions): WrappedContent;

  /**
   * Validate that a wrapped content string has intact boundaries.
   *
   * @param wrapped - Previously wrapped content
   * @param boundaryId - The expected boundary ID
   * @returns true if boundaries are intact
   */
  validate(wrapped: string, boundaryId: string): boolean;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/** Default maximum content length */
const DEFAULT_MAX_LENGTH = 100_000;

/**
 * Generate a cryptographically random boundary ID.
 * Uses 8 hex chars from crypto.randomUUID for sufficient uniqueness
 * while keeping boundary markers compact.
 */
function generateBoundaryId(): string {
  // Hard Rule #12: IDs via IdGenerator only (no raw crypto.randomUUID in Domain)
  // Slice to 8 hex chars — collision probability ≈ 1 in 4 billion
  return IdGenerator.generateRandomString(8, '0123456789abcdef');
}

/**
 * Sanitize content to remove potential boundary-closing attempts.
 * Strips any patterns that look like closing boundary tags.
 */
function sanitizeContent(content: string, boundaryId: string): string {
  // Remove any attempts to close our boundary tag
  const closingPattern = new RegExp(
    `</external-content\\s+boundary="${boundaryId}"\\s*/?>`,
    'gi',
  );
  let sanitized = content.replace(closingPattern, '[boundary-escape-attempt-removed]');

  // Also remove generic external-content closing tags
  sanitized = sanitized.replace(
    /<\/external-content\s+boundary="[^"]*"\s*\/?>/gi,
    '[boundary-tag-removed]',
  );

  return sanitized;
}

/**
 * ContentBoundaryWrapper — wraps untrusted content with randomized boundaries.
 *
 * Usage:
 * ```typescript
 * const wrapper = new ContentBoundaryWrapper();
 * const { content, boundaryId } = wrapper.wrap(fetchedHtml, { source: 'url', label: 'https://example.com' });
 * // content is now safely wrapped:
 * // <external-content source="url" label="https://example.com" boundary="a1b2c3d4">
 * // ...content...
 * // </external-content boundary="a1b2c3d4">
 * ```
 */
export class ContentBoundaryWrapper implements IContentBoundaryWrapper {
  wrap(content: string, options: WrapOptions): WrappedContent {
    const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
    const shouldSanitize = options.sanitize ?? true;

    // Generate random boundary
    const boundaryId = generateBoundaryId();

    // Truncate if needed
    let processedContent = content;
    const truncated = content.length > maxLength;
    if (truncated) {
      processedContent = content.slice(0, maxLength) + '\n[content truncated]';
    }

    // Sanitize to remove boundary-closing attempts
    if (shouldSanitize) {
      processedContent = sanitizeContent(processedContent, boundaryId);
    }

    // Build wrapped output
    const labelAttr = options.label ? ` label="${this.escapeAttr(options.label)}"` : '';
    const wrapped =
      `<external-content source="${options.source}"${labelAttr} boundary="${boundaryId}">\n` +
      `${processedContent}\n` +
      `</external-content boundary="${boundaryId}">`;

    return {
      content: wrapped,
      boundaryId,
      truncated,
      originalLength: content.length,
    };
  }

  validate(wrapped: string, boundaryId: string): boolean {
    const openPattern = new RegExp(
      `<external-content[^>]+boundary="${boundaryId}"[^>]*>`,
    );
    const closePattern = new RegExp(
      `</external-content\\s+boundary="${boundaryId}">`,
    );

    return openPattern.test(wrapped) && closePattern.test(wrapped);
  }

  /**
   * Escape XML attribute value to prevent attribute injection.
   */
  private escapeAttr(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
