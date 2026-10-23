/**
 * Manifest schema validation contracts for plugin manifests v2.
 * Layer: Domain
 *
 * This interface is intentionally decoupled from any particular
 * validation library (Ajv, Zod, etc.).
 */

/**
 * Single validation issue produced when validating a manifest
 * against the canonical JSON Schema.
 */
export interface ManifestValidationIssue {
  /** JSONPath-like path to the offending field (e.g. "/identity/name"). */
  path: string;
  /** Human-readable description of the problem. */
  message: string;
  /** Optional underlying validator keyword (e.g. "required", "enum"). */
  keyword?: string;
}

/**
 * Result of manifest schema validation.
 *
 * Validation MUST NOT throw for schema violations; instead
 * it returns `valid = false` with at least one issue.
 */
export interface ManifestValidationResult {
  /** Whether the manifest is valid according to the JSON Schema. */
  valid: boolean;
  /** Detailed list of schema violations (empty when `valid === true`). */
  issues: ManifestValidationIssue[];
}

/**
 * Schema-level validator for plugin manifests (manifest v2).
 *
 * Implementations may use any underlying validation engine
 * but MUST NOT leak its types to Domain layer.
 */
export interface IManifestSchemaValidator {
  /**
   * Validate an arbitrary manifest object.
   *
   * @param rawManifest - Parsed manifest object (JSON or YAML).
   * @returns Structured validation result.
   */
  validateManifest(rawManifest: unknown): ManifestValidationResult;
}