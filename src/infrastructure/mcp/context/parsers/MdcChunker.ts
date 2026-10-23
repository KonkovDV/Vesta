/**
 * MdcChunker — Hierarchical chunking for .mdc rule files.
 *
 * Layer: Infrastructure (dev-time)
 *
 * Implements 3-level hierarchical chunking from SOTA 2026 research:
 * - **Parent chunk:** Full .mdc file content (for broad context generation)
 * - **Section chunk:** Individual sections within a .mdc (## headers)
 * - **Rule chunk:** Individual rules/bullet points (finest granularity for search)
 *
 * Overlapping context is preserved via parent references in child chunks.
 *
 * @Horizon 0 — Hierarchical Chunking (Context Engineering)
 * @see PLANS/06_BLUEPRINTS/HYPER_DEEP_SOTA_2026_CONTEXT_ENGINEERING_RU.md §1.3
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

// ── Types ───────────────────────────────────────────────────────────

export type ChunkLevel = 'parent' | 'section' | 'rule';

export interface MdcChunk {
  /** Unique chunk identifier: <file>#<section>#<ruleIdx> */
  readonly chunkId: string;
  /** Hierarchical level */
  readonly level: ChunkLevel;
  /** Source .mdc file path (relative to project root) */
  readonly source: string;
  /** Section title (for section/rule chunks) */
  readonly section?: string;
  /** Actual text content */
  readonly content: string;
  /** Estimated token count (chars / 4) */
  readonly estimatedTokens: number;
  /** Parent chunk ID (section → parent, rule → section) */
  readonly parentChunkId?: string;
  /** Glob patterns this .mdc applies to */
  readonly globs?: string[];
  /** Whether this .mdc is alwaysApply */
  readonly alwaysApply: boolean;
  /** Related chunks by domain (same .mdc file, same layer, same domain tags) */
  readonly relatedChunkIds?: readonly string[];
  /** Domain tags extracted from content (e.g., 'di', 'events', 'security') */
  readonly domainTags?: readonly string[];
}

/** Writable variant of MdcChunk, used internally during post-processing enrichment. */
type MutableMdcChunk = { -readonly [K in keyof MdcChunk]: MdcChunk[K] extends readonly (infer U)[] ? U[] : MdcChunk[K] };

// ── Constants ───────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

/**
 * Domain keyword → tag mapping for cross-reference tagging.
 * Used to extract domain tags from chunk content.
 */
const DOMAIN_TAG_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['di', ['DI_TOKENS', 'container.resolve', 'dependency injection', 'DI token', 'DI-токен']],
  ['events', ['IEventStore', 'EventBus', 'DomainEvent', 'event sourcing', 'outbox']],
  ['security', ['IPromptInjectionScanner', 'IOutputRail', 'guardrail', 'SSRF', 'injection']],
  ['mcp', ['MCP', 'McpServer', 'Model Context Protocol', 'StdioServerTransport']],
  ['a2a', ['A2A', 'Agent Card', 'agentgateway', 'IA2AAuthorizationGuard']],
  ['testing', ['jest', 'test', 'describe(', 'it(', 'expect(']],
  ['context', ['S-MMU', 'SemanticPaging', 'context engineering', 'IMainContextProvider']],
  ['llm', ['LLM', 'LLMAdapter', 'embedding', 'token budget']],
  ['memory', ['ISessionMemoryManager', 'mem0', 'archival', 'recall']],
  ['finops', ['TokenomicsController', 'cost control', 'ITokenomicsController']],
]);

// ── Chunker ─────────────────────────────────────────────────────────

export class MdcChunker {
  private static cache: Map<string, MdcChunk[]> | null = null;

  /**
   * Parse all .mdc files in a directory tree and produce hierarchical chunks.
   * Returns a flat array of all chunks (parent + section + rule).
   */
  static chunkAll(projectRoot: string): MdcChunk[] {
    if (this.cache) {
      const cached = this.cache.get(projectRoot);
      if (cached) return cached;
    }

    const cursorDir = path.join(projectRoot, '.cursor', 'rules');
    const allChunks: MdcChunk[] = [];

    if (!fs.existsSync(cursorDir)) return allChunks;

    const mdcFiles = fs.readdirSync(cursorDir).filter((f) => f.endsWith('.mdc'));

    for (const filename of mdcFiles) {
      const fullPath = path.join(cursorDir, filename);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relPath = `.cursor/rules/${filename}`;
        const chunks = this.chunkFile(content, relPath, filename);
        allChunks.push(...chunks);
      } catch {
        // Skip unreadable files
      }
    }

    // ── Post-processing: domain tags + cross-references ─────────────
    this.enrichWithDomainTags(allChunks);
    this.buildCrossReferences(allChunks);

    if (!this.cache) this.cache = new Map();
    this.cache.set(projectRoot, allChunks);
    return allChunks;
  }

  /**
   * Parse a single .mdc file into hierarchical chunks.
   */
  static chunkFile(content: string, relPath: string, filename: string): MdcChunk[] {
    const chunks: MdcChunk[] = [];
    const { frontmatter, body } = this.parseFrontmatter(content);

    const alwaysApply = frontmatter.alwaysApply === true || frontmatter.alwaysApply === 'true';
    const globs = this.parseGlobs(frontmatter.globs);
    const baseName = filename.replace(/\.mdc$/, '');

    // ── Level 1: Parent chunk (full file) ─────────────────────────
    const parentId = `mdc:${baseName}`;
    chunks.push({
      chunkId: parentId,
      level: 'parent',
      source: relPath,
      content: body.trim(),
      estimatedTokens: this.estimateTokens(body),
      alwaysApply,
      globs,
    });

    // ── Level 2: Section chunks (split by ## headers) ─────────────
    const sections = this.splitSections(body);

    for (let sIdx = 0; sIdx < sections.length; sIdx++) {
      const section = sections[sIdx];
      const sectionId = `mdc:${baseName}#${this.slugify(section.title)}`;

      chunks.push({
        chunkId: sectionId,
        level: 'section',
        source: relPath,
        section: section.title,
        content: section.content.trim(),
        estimatedTokens: this.estimateTokens(section.content),
        parentChunkId: parentId,
        alwaysApply,
        globs,
      });

      // ── Level 3: Rule chunks (individual bullets/lines) ─────────
      const rules = this.splitRules(section.content);

      for (let rIdx = 0; rIdx < rules.length; rIdx++) {
        const rule = rules[rIdx];
        if (rule.trim().length < 10) continue; // Skip trivial lines

        const ruleId = `mdc:${baseName}#${this.slugify(section.title)}#r${rIdx}`;
        chunks.push({
          chunkId: ruleId,
          level: 'rule',
          source: relPath,
          section: section.title,
          content: rule.trim(),
          estimatedTokens: this.estimateTokens(rule),
          parentChunkId: sectionId,
          alwaysApply,
          globs,
        });
      }
    }

    return chunks;
  }

  // ── Internal Parsers ──────────────────────────────────────────────

  private static parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    body: string;
  } {
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!fmMatch) return { frontmatter: {}, body: content };

    const fmBlock = fmMatch[1];
    const body = fmMatch[2];
    const frontmatter: Record<string, unknown> = {};

    for (const line of fmBlock.split('\n')) {
      const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
      if (kv) {
        const key = kv[1];
        let value: unknown = kv[2].trim();
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        frontmatter[key] = value;
      }
    }

    return { frontmatter, body };
  }

  private static parseGlobs(raw: unknown): string[] | undefined {
    if (!raw) return undefined;
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
      // Handle YAML list inline: "  - src/domain/**\n  - src/core/**"
      return raw
        .split('\n')
        .map((l) => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean);
    }
    return undefined;
  }

  private static splitSections(body: string): Array<{ title: string; content: string }> {
    const sections: Array<{ title: string; content: string }> = [];
    const lines = body.split('\n');
    let currentTitle = '_root';
    let currentLines: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^#{1,3}\s+(.+)$/);
      if (headerMatch) {
        // Flush previous section
        if (currentLines.length > 0) {
          sections.push({ title: currentTitle, content: currentLines.join('\n') });
        }
        currentTitle = headerMatch[1].trim();
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }

    // Flush last section
    if (currentLines.length > 0) {
      sections.push({ title: currentTitle, content: currentLines.join('\n') });
    }

    return sections;
  }

  private static splitRules(sectionContent: string): string[] {
    const rules: string[] = [];
    const lines = sectionContent.split('\n');
    let currentRule: string[] = [];

    for (const line of lines) {
      // New rule starts with: "- ", "1. ", "- **", header, or numbered item
      const isNewRule = /^(\s*[-*]\s|\s*\d+\.\s|#{1,3}\s)/.test(line);

      if (isNewRule && currentRule.length > 0) {
        rules.push(currentRule.join('\n'));
        currentRule = [line];
      } else {
        currentRule.push(line);
      }
    }

    if (currentRule.length > 0) {
      rules.push(currentRule.join('\n'));
    }

    return rules;
  }

  private static slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  private static estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  // ── Cross-reference enrichment ────────────────────────────────────

  /**
   * Extract domain tags from chunk content using keyword matching.
   * Tags enable cross-domain search and multi-hop query optimization.
   */
  private static enrichWithDomainTags(chunks: MdcChunk[]): void {
    for (const chunk of chunks) {
      const tags: string[] = [];
      const contentLower = chunk.content.toLowerCase();

      for (const [tag, keywords] of DOMAIN_TAG_KEYWORDS) {
        const matched = keywords.some((kw) => contentLower.includes(kw.toLowerCase()));
        if (matched) {
          tags.push(tag);
        }
      }

      if (tags.length > 0) {
        (chunk as MutableMdcChunk).domainTags = tags;
      }
    }
  }

  /**
   * Build cross-references between chunks that share domain tags.
   * Links sibling chunks (same source file) and tag-related chunks (same domain).
   */
  private static buildCrossReferences(chunks: MdcChunk[]): void {
    // Group chunks by domain tag
    const tagToChunkIds = new Map<string, string[]>();
    for (const chunk of chunks) {
      if (chunk.domainTags) {
        for (const tag of chunk.domainTags) {
          let ids = tagToChunkIds.get(tag);
          if (!ids) {
            ids = [];
            tagToChunkIds.set(tag, ids);
          }
          ids.push(chunk.chunkId);
        }
      }
    }

    // For each chunk, gather related chunk IDs from shared tags (limit to 10)
    for (const chunk of chunks) {
      if (!chunk.domainTags || chunk.domainTags.length === 0) continue;

      const relatedIds = new Set<string>();
      for (const tag of chunk.domainTags) {
        const ids = tagToChunkIds.get(tag);
        if (ids) {
          for (const id of ids) {
            if (id !== chunk.chunkId) {
              relatedIds.add(id);
            }
          }
        }
      }

      if (relatedIds.size > 0) {
        (chunk as MutableMdcChunk).relatedChunkIds =
          [...relatedIds].slice(0, 10);
      }
    }
  }

  static invalidate(): void {
    this.cache = null;
  }
}
