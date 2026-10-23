/**
 * Skill Discovery Adapter — Infrastructure implementation of ISkillDiscoveryService.
 *
 * Provides manifest-based skill discovery with keyword search and
 * on-demand full loading. Uses filesystem scanning for skill detection
 * and caches loaded definitions for performance.
 *
 * @layer Infrastructure (Skills)
 * @pattern CC-011 Skill Discovery in Monorepos (FITNESS-K: 71.5)
 * @see src/domain/agents/ISkillDiscoveryService.ts — domain port
 * @see src/infrastructure/skills/file-system-skill-loader.ts — existing skill loading infrastructure
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ISkillDiscoveryService,
  SkillManifest,
  SkillDefinition,
  SkillDiscoveryFilter,
  SkillLoadResult,
} from '../../domain/agents/ISkillDiscoveryService';

// ── Minimal Logger ────────────────────────────────────────────────

interface SkillDiscoveryLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── Constants ─────────────────────────────────────────────────────

const ESTIMATED_TOKENS_PER_CHAR = 0.25; // rough estimate for English/code

// ── Adapter ───────────────────────────────────────────────────────

export class SkillDiscoveryAdapter implements ISkillDiscoveryService {
  /** In-memory manifest registry. */
  private readonly manifestIndex = new Map<string, SkillManifest>();

  /** Cache for fully loaded skill definitions. */
  private readonly definitionCache = new Map<string, SkillDefinition>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly logger?: SkillDiscoveryLogger,
  ) {}

  // ── Public: register manifests programmatically ─────────────────

  /**
   * Register a manifest (e.g. from scan results). Not part of the domain
   * port — used by DI or setup code to seed the index.
   */
  addManifest(manifest: SkillManifest): void {
    this.manifestIndex.set(manifest.id, manifest);
  }

  // ── ISkillDiscoveryService ──────────────────────────────────────

  getManifests(filter?: SkillDiscoveryFilter): SkillManifest[] {
    let results = Array.from(this.manifestIndex.values());

    if (filter?.tags && filter.tags.length > 0) {
      const tagSet = new Set(filter.tags);
      results = results.filter(m => m.tags.some(t => tagSet.has(t)));
    }

    if (filter?.maxTokens !== undefined) {
      results = results.filter(m => m.estimatedTokens <= filter.maxTokens!);
    }

    if (filter?.limit !== undefined && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async loadFull(skillId: string): Promise<SkillLoadResult> {
    // Return from cache if available
    const cached = this.definitionCache.get(skillId);
    if (cached) {
      return { definition: cached, fromCache: true };
    }

    const manifest = this.manifestIndex.get(skillId);
    if (!manifest) {
      return { definition: null, fromCache: false, error: `No manifest for skill: ${skillId}` };
    }

    const startMs = Date.now();
    try {
      const absolutePath = path.isAbsolute(manifest.filePath)
        ? manifest.filePath
        : path.resolve(this.workspaceRoot, manifest.filePath);

      const raw = await fs.readFile(absolutePath, 'utf-8');
      const { frontmatter, content } = this.parseFrontmatter(raw);
      const loadDurationMs = Date.now() - startMs;
      const actualTokens = Math.ceil(content.length * ESTIMATED_TOKENS_PER_CHAR);

      const definition: SkillDefinition = {
        manifest,
        content,
        frontmatter,
        actualTokens,
        loadDurationMs,
      };

      this.definitionCache.set(skillId, definition);

      this.logger?.info('Skill loaded', {
        skillId,
        actualTokens,
        loadDurationMs,
      });

      return { definition, fromCache: false };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger?.error('Skill load failed', { skillId, error: errorMsg });
      return { definition: null, fromCache: false, error: errorMsg };
    }
  }

  searchByKeyword(keyword: string): SkillManifest[] {
    const lower = keyword.toLowerCase();
    return Array.from(this.manifestIndex.values()).filter(m =>
      m.name.toLowerCase().includes(lower) ||
      m.description.toLowerCase().includes(lower) ||
      m.tags.some(t => t.toLowerCase().includes(lower)),
    );
  }

  getTokenBudget(skillId: string): number {
    const cached = this.definitionCache.get(skillId);
    if (cached) {
      return cached.actualTokens;
    }
    const manifest = this.manifestIndex.get(skillId);
    return manifest?.estimatedTokens ?? 0;
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
    const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
    const match = fmRegex.exec(raw);

    if (!match) {
      return { frontmatter: {}, content: raw };
    }

    try {
      // Simple YAML key: value parser (avoids yaml dependency)
      const fm: Record<string, unknown> = {};
      for (const line of match[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim();
          // Strip quotes
          fm[key] = val.replace(/^["']|["']$/g, '');
        }
      }
      return { frontmatter: fm, content: match[2] };
    } catch {
      return { frontmatter: {}, content: raw };
    }
  }
}
