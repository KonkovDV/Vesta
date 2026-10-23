/**
 * Shared helpers for PostgreSQL identifier validation and quoting.
 *
 * Layer: Infrastructure
 *
 * Centralizes security-sensitive logic used by EventStore / Outbox
 * to prevent SQL injection via dynamic schema / table / column names.
 */

const IDENT_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Lightweight check for PostgreSQL identifier validity.
 *
 * Accepts unquoted identifiers composed of latin letters, digits and '_'
 * and not starting with a digit, with length <= 63 (PostgreSQL limit).
 */
export function isValidPostgresIdentifier(identifier: string): boolean {
  return IDENT_REGEX.test(identifier) && identifier.length <= MAX_IDENTIFIER_LENGTH;
}

/**
 * Validate identifier and return a safely double-quoted representation.
 *
 * Throws a configuration error if identifier is not valid.
 */
export function validateAndQuoteIdentifier(identifier: string, context: string): string {
  if (!isValidPostgresIdentifier(identifier)) {
    throw new Error(
      `Invalid PostgreSQL identifier for ${context}: "${identifier}"`,
    );
  }
  // Double any existing quotes defensively, even though IDENT_REGEX
  // already rejects them.
  const escaped = identifier.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Qualify schema + table identifiers into "schema"."table" form
 * with validation and defensive quoting.
 */
export function qualifyIdentifier(
  schema: string,
  table: string,
  context: string,
): string {
  const schemaQuoted = validateAndQuoteIdentifier(schema, `${context}.schema`);
  const tableQuoted = validateAndQuoteIdentifier(table, `${context}.table`);
  return `${schemaQuoted}.${tableQuoted}`;
}