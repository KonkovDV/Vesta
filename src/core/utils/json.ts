/**
 * JSON utilities: safe parsing helpers for untrusted input.
 * Layer: Core
 */

import { isNonNullObject } from '../guards/type-guards';

export type JsonParseResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: SyntaxError };

/**
 * Safely parse JSON string with optional fallback.
 *
 * - On success returns parsed value.
 * - On SyntaxError returns provided fallback or null.
 *
 * NOTE: Does NOT validate that parsed value matches expected type T.
 * Use Zod schemas for runtime type validation.
 */
export function safeJsonParse<T = unknown>(text: string, fallback?: T): T | null {
  try {
    const parsed = JSON.parse(text);
    // Basic validation to ensure we don't return primitives when object expected
    if (fallback !== undefined) {
      const fallbackType = typeof fallback;
      const parsedType = typeof parsed;
      if (fallbackType === 'object' && fallback !== null && !isNonNullObject(parsed)) {
        return fallback;
      }
    }
    return parsed as T;
  } catch {
    return fallback ?? null;
  }
}

/**
 * Try to parse JSON string and capture SyntaxError instead of throwing.
 * Delegates to safeJsonParse so that JSON.parse is centralized.
 */
export function tryJsonParse<T = unknown>(text: string): JsonParseResult<T> {
  try {
    const value = JSON.parse(text);
    return { ok: true, value: value as T };
  } catch (error) {
    return { ok: false, error: error as SyntaxError };
  }
}