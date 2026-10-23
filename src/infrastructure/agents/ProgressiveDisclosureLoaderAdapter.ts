/**
 * ProgressiveDisclosureLoaderAdapter — Infrastructure adapter for AS-001 Progressive Disclosure.
 *
 * In-memory implementation of IProgressiveDisclosureLoader providing 3-level
 * progressive content loading with token budget estimation. Content is loaded
 * cumulatively: metadata → instructions → resources. Each level's content
 * is cached after first load.
 *
 * @layer Infrastructure (Agents)
 * @pattern AS-001 Progressive Disclosure (FITNESS-K: 82)
 * @see src/domain/agents/IProgressiveDisclosureLoader.ts — domain port
 */

import type {
  IProgressiveDisclosureLoader,
  DisclosureLevel,
  DisclosureManifest,
  DisclosureState,
  DisclosedContent,
} from '../../domain/agents/IProgressiveDisclosureLoader';

// ─── Helpers ─────────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Ordered disclosure levels for comparison. */
const LEVEL_ORDER: readonly DisclosureLevel[] = ['metadata', 'instructions', 'resources'];

function levelIndex(level: DisclosureLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Rough token estimation: ~4 chars per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Adapter ─────────────────────────────────────────────────────

export class ProgressiveDisclosureLoaderAdapter implements IProgressiveDisclosureLoader {
  private readonly manifests = new Map<string, DisclosureManifest>();
  private readonly states = new Map<string, DisclosureState>();
  private readonly contentCache = new Map<string, Map<DisclosureLevel, string>>();
  private readonly logger?: MinimalLogger;

  constructor(logger?: MinimalLogger) {
    this.logger = logger;
  }

  register(manifest: DisclosureManifest): void {
    this.manifests.set(manifest.contentId, manifest);

    // Initialize content cache with metadata (always available immediately)
    const cache = new Map<DisclosureLevel, string>();
    cache.set('metadata', `name: ${manifest.name}\ndescription: ${manifest.description}`);
    this.contentCache.set(manifest.contentId, cache);

    this.logger?.info('Disclosure manifest registered', {
      contentId: manifest.contentId,
      name: manifest.name,
      metadataTokens: manifest.metadataTokens,
      estimatedInstructionTokens: manifest.estimatedInstructionTokens,
      resourceCount: manifest.resourcePaths.length,
    });
  }

  async loadAtLevel(contentId: string, level: DisclosureLevel): Promise<DisclosedContent> {
    const startTime = Date.now();
    const manifest = this.manifests.get(contentId);

    if (!manifest) {
      return {
        contentId,
        level,
        content: '',
        actualTokens: 0,
        loadDurationMs: Date.now() - startTime,
      };
    }

    // Check if already loaded at this or higher level
    const currentState = this.states.get(contentId);
    if (currentState && levelIndex(currentState.currentLevel) >= levelIndex(level)) {
      const cached = this.contentCache.get(contentId)?.get(currentState.currentLevel) ?? '';
      return {
        contentId,
        level: currentState.currentLevel,
        content: cached,
        actualTokens: currentState.totalTokensConsumed,
        loadDurationMs: Date.now() - startTime,
      };
    }

    // Build content cumulatively
    const cache = this.contentCache.get(contentId) ?? new Map<DisclosureLevel, string>();
    let content = cache.get('metadata') ?? `name: ${manifest.name}\ndescription: ${manifest.description}`;
    let totalTokens = manifest.metadataTokens;

    if (levelIndex(level) >= levelIndex('instructions')) {
      // Level 2: instructions content (simulated — in real adapter would read file)
      const instructionsContent = `\n---\n[Instructions from: ${manifest.instructionsPath}]`;
      content += instructionsContent;
      totalTokens += manifest.estimatedInstructionTokens;
      cache.set('instructions', content);
    }

    if (levelIndex(level) >= levelIndex('resources')) {
      // Level 3: resource paths (simulated — in real adapter would read files)
      const resourcesContent = manifest.resourcePaths.length > 0
        ? `\n---\n[Resources: ${manifest.resourcePaths.join(', ')}]`
        : '';
      content += resourcesContent;
      totalTokens += estimateTokens(resourcesContent);
      cache.set('resources', content);
    }

    this.contentCache.set(contentId, cache);

    // Update disclosure state
    const newState: DisclosureState = {
      contentId,
      currentLevel: level,
      loadedAt: nowISO(),
      totalTokensConsumed: totalTokens,
    };
    this.states.set(contentId, newState);

    this.logger?.info('Content loaded at level', {
      contentId,
      level,
      actualTokens: totalTokens,
      durationMs: Date.now() - startTime,
    });

    return {
      contentId,
      level,
      content,
      actualTokens: totalTokens,
      loadDurationMs: Date.now() - startTime,
    };
  }

  estimateTokensForLevel(contentId: string, level: DisclosureLevel): number {
    const manifest = this.manifests.get(contentId);
    if (!manifest) {
      return -1;
    }

    let tokens = manifest.metadataTokens;

    if (levelIndex(level) >= levelIndex('instructions')) {
      tokens += manifest.estimatedInstructionTokens;
    }

    if (levelIndex(level) >= levelIndex('resources')) {
      // Resources are unbounded — estimate from path count
      tokens += manifest.resourcePaths.length * 500; // rough estimate per resource
    }

    return tokens;
  }

  getDisclosureState(contentId: string): DisclosureState | undefined {
    return this.states.get(contentId);
  }

  recommendLevel(contentId: string, query: string): DisclosureLevel {
    const manifest = this.manifests.get(contentId);
    if (!manifest) {
      return 'metadata';
    }

    const queryLower = query.toLowerCase();
    const nameLower = manifest.name.toLowerCase();
    const descLower = manifest.description.toLowerCase();

    // Check for strong relevance indicators
    const nameMatch = queryLower.includes(nameLower) || nameLower.includes(queryLower);

    // Check description word overlap
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3);
    const descWords = descLower.split(/\s+/);
    const matchingWords = queryWords.filter(qw => descWords.some(dw => dw.includes(qw)));
    const overlapRatio = queryWords.length > 0 ? matchingWords.length / queryWords.length : 0;

    // Strong match → load resources; moderate → instructions; weak → metadata only
    if (nameMatch || overlapRatio > 0.5) {
      return manifest.resourcePaths.length > 0 ? 'resources' : 'instructions';
    }

    if (overlapRatio > 0.2) {
      return 'instructions';
    }

    return 'metadata';
  }
}
