/**
 * RedactIdentifier — privacy-safe identifier hashing for logs
 *
 * Hashes identifiers using SHA-256 prefix for privacy-safe structured logging.
 * Example: "secret-token-123" → "sha256:a1b2c3d4e5f6"
 *
 * @donor external/openclaw/src/logging/redact-identifier.ts
 * @license MIT (OpenClaw)
 */

import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 hex prefix of a string value.
 * @param value - Input string to hash
 * @param len - Number of hex characters to return (default: 12)
 */
export function sha256HexPrefix(value: string, len = 12): string {
  const safeLen = Number.isFinite(len) ? Math.max(1, Math.floor(len)) : 12;
  return createHash('sha256').update(value).digest('hex').slice(0, safeLen);
}

/**
 * Redact an identifier for logging: returns "sha256:<hex prefix>".
 * Returns "-" for empty/undefined input.
 */
export function redactIdentifier(value: string | undefined, opts?: { len?: number }): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return '-';
  }
  return `sha256:${sha256HexPrefix(trimmed, opts?.len ?? 12)}`;
}
