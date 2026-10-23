/**
 * Plugin manifest store contracts (manifest v2).
 * Layer: Domain
 *
 * Store is responsible only for loading, validating and caching
 * manifests; it MUST NOT implement any policy enforcement
 * (trust tiers, residency checks, budgets, etc.).
 */

import type { ManifestValidationIssue } from './manifest-schema-validator.interface';

/**
 * Logical identifier of a plugin manifest v2.
 *
 * This is derived from manifest.identity.name/version after
 * successful schema validation.
 */
export interface PluginManifestId {
  /** Plugin identifier (manifest.identity.name). */
  name: string;
  /** Semantic version (manifest.identity.version). */
  version: string;
}

/**
 * Immutable snapshot of a validated plugin manifest.
 *
 * Snapshot is safe to cache and share across callers.
 */
export interface PluginManifestSnapshot {
  /** Logical identifier (name + version). */
  id: PluginManifestId;

  /**
   * Original manifest object (already validated).
   * Type is intentionally `unknown` to keep Domain decoupled
   * from concrete manifest DTOs.
   */
  raw: unknown;

  /**
   * Where the manifest was loaded from.
   *
   * For FileSystem-based stores this is an absolute file path;
   * for registry-backed stores it may be a URI.
   */
  source: string;

  /**
   * Optional fingerprint of the manifest contents.
   *
   * For manifest v2 runtime store this SHOULD be a SHA-256 hash
   * of the canonical JSON representation (e.g. "sha256:<hex>").
   */
  fingerprint?: string;
}

/**
 * Technical error thrown when a manifest fails schema validation
 * at store level.
 *
 * This lives in Domain so that callers can react to validation
 * errors without depending on infrastructure details.
 */
export class PluginManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly issues: ManifestValidationIssue[],
  ) {
    super(message);
    this.name = 'PluginManifestValidationError';
  }
}

/**
 * Abstract store for plugin manifests.
 *
 * Responsibilities:
 * - load manifests from underlying storage (filesystem, registry, etc.);
 * - validate them via IManifestSchemaValidator;
 * - cache immutable snapshots by (name, version).
 *
 * It MUST NOT implement per-call policy decisions.
 */
export interface IPluginManifestStore {
  /**
   * Load and validate a manifest from the given path/URI.
   *
   * Implementations SHOULD cache the resulting snapshot so that
   * subsequent calls for the same manifest do not re-validate it.
   *
   * @throws PluginManifestValidationError when schema validation fails.
   */
  loadByPath(path: string): Promise<PluginManifestSnapshot>;

  /**
   * Retrieve a previously loaded manifest snapshot by its id.
   *
   * Implementations MAY choose to lazily discover manifests from
   * well-known locations, but the minimal contract is:
   * - return cached snapshot if present;
   * - otherwise return null.
   */
  getById(id: PluginManifestId): Promise<PluginManifestSnapshot | null>;

  /**
   * Optional hook for stores that support bulk refresh from
   * underlying storage or registry.
   */
  refreshAll?(): Promise<void>;
}