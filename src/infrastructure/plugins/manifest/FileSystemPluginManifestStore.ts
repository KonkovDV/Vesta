import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import yaml from 'yaml';

import type { IManifestSchemaValidator } from '../../../domain/plugins/manifest/manifest-schema-validator.interface';
import { tryJsonParse } from '../../../core/utils/json';
import { InfrastructureError } from '../../../domain/errors/DomainError';
import type {
  IPluginManifestStore,
  PluginManifestId,
  PluginManifestSnapshot,
} from '../../../domain/plugins/manifest/plugin-manifest-store.interface';
import { PluginManifestValidationError } from '../../../domain/plugins/manifest/plugin-manifest-store.interface';

/**
 * File-system based implementation of IPluginManifestStore.
 *
 * Responsibilities:
 * - load plugin manifests (JSON/YAML) from disk;
 * - validate them via IManifestSchemaValidator;
 * - compute a stable fingerprint (SHA-256 over JSON representation);
 * - cache immutable snapshots by (name, version).
 *
 * This store performs no policy decisions (trust/residency/budgets/etc.).
 */
export class FileSystemPluginManifestStore implements IPluginManifestStore {
  private readonly rootDir: string;
  private readonly cache = new Map<string, PluginManifestSnapshot>();

  constructor(
    private readonly validator: IManifestSchemaValidator,
    rootDir?: string,
  ) {
    this.rootDir = rootDir ?? process.cwd();
  }

  /**
   * Load and validate a manifest from file system.
   *
   * @param filePath - Absolute or rootDir-relative path to manifest file.
   * @throws PluginManifestValidationError when schema validation fails.
   */
  async loadByPath(filePath: string): Promise<PluginManifestSnapshot> {
    const absolutePath = this.resolvePath(filePath);

    const text = await this.readFile(absolutePath);
    const rawManifest = this.parseManifestText(absolutePath, text);

    const validation = this.validator.validateManifest(rawManifest);
    if (!validation.valid) {
      throw new PluginManifestValidationError(
        `Manifest "${absolutePath}" failed schema validation`,
        absolutePath,
        validation.issues,
      );
    }

    const { name, version } = this.extractIdentity(absolutePath, rawManifest);

    const id: PluginManifestId = { name, version };
    const fingerprint = this.computeFingerprint(rawManifest);

    const snapshot: PluginManifestSnapshot = {
      id,
      raw: rawManifest,
      source: absolutePath,
      fingerprint,
    };

    this.cache.set(this.computeKey(id), snapshot);
    return snapshot;
  }

  /**
   * Return cached snapshot by id or null if it is not loaded yet.
   *
   * Current implementation does not perform any lazy discovery from disk.
   */
  async getById(id: PluginManifestId): Promise<PluginManifestSnapshot | null> {
    const key = this.computeKey(id);
    return this.cache.get(key) ?? null;
  }

  /**
   * Optional bulk refresh hook - noop in the initial implementation.
   *
   * Future iterations may reload manifests from well-known directories,
   * e.g. pattern like plugins/**\/manifest.* under a configured root.
   */
  async refreshAll(): Promise<void> {
    // No-op for now.
  }

  // -------- Internal helpers --------

  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.resolve(this.rootDir, filePath);
  }

  private async readFile(absolutePath: string): Promise<string> {
    try {
      return await fs.readFile(absolutePath, 'utf-8');
    } catch (error) {
      throw new InfrastructureError(
        `Failed to read manifest file "${absolutePath}": ${(error as Error).message}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  private parseManifestText(absolutePath: string, text: string): unknown {
    const ext = path.extname(absolutePath).toLowerCase();

    try {
      if (ext === '.yaml' || ext === '.yml') {
        return yaml.parse(text);
      }
      // Default to JSON for all other extensions.
      const parsed = tryJsonParse<unknown>(text);
      if (!parsed.ok) {
        throw parsed.error;
      }
      return parsed.value;
    } catch (error) {
      throw new InfrastructureError(
        `Failed to parse manifest file "${absolutePath}": ${(error as Error).message}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  private extractIdentity(absolutePath: string, raw: unknown): { name: string; version: string } {
    const manifest = raw as Record<string, unknown>;
    
    const identityRaw = manifest?.identity;
    const identity = (identityRaw && typeof identityRaw === 'object') ? identityRaw as Record<string, unknown> : undefined;
    const name: unknown = identity?.name;
    const version: unknown = identity?.version;

    if (typeof name !== 'string' || typeof version !== 'string') {
      // This situation should not occur if schema validation passed,
      // but we still guard against inconsistent implementations.
      throw new InfrastructureError(
        `Validated manifest "${absolutePath}" is missing identity.name or identity.version`,
      );
    }

    return { name, version };
  }

  private computeFingerprint(rawManifest: unknown): string {
    const json = JSON.stringify(rawManifest);
    const hash = crypto.createHash('sha256').update(json).digest('hex');
    return `sha256:${hash}`;
  }

  private computeKey(id: PluginManifestId): string {
    return `${id.name}@${id.version}`;
  }
}