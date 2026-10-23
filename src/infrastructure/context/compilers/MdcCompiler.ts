/**
 * MdcCompiler — Dynamic MDC file compiler with @import/@file directive resolution.
 *
 * Compiles .mdc rule files by:
 * 1. Parsing @import and @file directives (MdcDirectiveParser)
 * 2. Resolving cross-MDC imports with circular dependency protection
 * 3. Inlining external file content (@file)
 * 4. Deduplicating overlapping sections across files
 * 5. Producing unified MdcChunk[] via MdcChunker
 *
 * Designed for seamless backward compatibility with MdcChunker.chunkAll().
 *
 * @layer Infrastructure/Context
 * @phase 4 — V3 Context Engineering: Dynamic MDC Compilation
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  parseDirectives,
  extractSection,
  extractJsonKey,
  type MdcDirective,
} from './MdcDirectiveParser';
import { MdcChunker, type MdcChunk } from '../../mcp/context/parsers/MdcChunker';

// ── Types ───────────────────────────────────────────────────────────

export interface CompileOptions {
  /** Skip filesystem I/O (for testing with in-memory content) */
  readonly dryRun?: boolean;
}

export interface CompileResult {
  /** Compiled content (directives resolved, sections inlined) */
  readonly content: string;
  /** Directives that were resolved */
  readonly resolvedDirectives: readonly MdcDirective[];
  /** Warnings (circular imports, missing files, etc.) */
  readonly warnings: readonly string[];
}

/** On-disk cache entry for a single compiled MDC file */
interface DiskCacheEntry {
  /** SHA-256 hash of the raw MDC file content */
  hash: string;
  /** SHA-256 hashes of files referenced via @import directives */
  importHashes: Record<string, string>;
  /** The compiled result */
  result: CompileResult;
}

/** Shape of `.mdc.cache.json` */
interface DiskCache {
  version: 1;
  entries: Record<string, DiskCacheEntry>;
}

// ── Compiler ────────────────────────────────────────────────────────

export class MdcCompiler {
  private readonly rulesDir: string;
  private readonly projectRoot: string;
  private readonly cache = new Map<string, CompileResult>();
  private readonly diskCachePath: string;
  private diskCache: DiskCache | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.rulesDir = path.join(projectRoot, '.cursor', 'rules');
    this.diskCachePath = path.join(this.rulesDir, '.mdc.cache.json');
    this.loadDiskCache();
  }

  /**
   * Compile a single MDC file by name, resolving all directives.
   *
   * @param mdcName — MDC file name without extension (e.g. 'architecture')
   * @param visited — set of already-visited MDC names for circular import detection
   * @returns compiled content with all directives resolved
   */
  compile(mdcName: string, visited = new Set<string>()): CompileResult {
    if (this.cache.has(mdcName) && visited.size === 0) {
      return this.cache.get(mdcName)!;
    }

    // ── Try disk cache for top-level compilations ──
    if (visited.size === 0) {
      const diskHit = this.tryDiskCache(mdcName);
      if (diskHit) {
        this.cache.set(mdcName, diskHit);
        return diskHit;
      }
    }

    const warnings: string[] = [];

    // ── Circular import check ──
    if (visited.has(mdcName)) {
      warnings.push(`Circular @import detected: ${mdcName}`);
      return {
        content: `<!-- circular reference: ${mdcName} -->\n`,
        resolvedDirectives: [],
        warnings,
      };
    }
    visited.add(mdcName);

    // ── Read MDC file ──
    const filePath = path.join(this.rulesDir, `${mdcName}.mdc`);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      warnings.push(`MDC file not found: ${filePath}`);
      return { content: '', resolvedDirectives: [], warnings };
    }

    // ── Strip frontmatter (preserve for metadata but don't compile) ──
    const { body } = this.stripFrontmatter(raw);

    // ── Parse directives ──
    const { directives, cleanContent } = parseDirectives(body);
    const resolvedDirectives: MdcDirective[] = [];
    let compiled = cleanContent;

    // ── Resolve directives ──
    for (const dir of directives) {
      try {
        const { resolved, nestedWarnings } = this.resolveDirectiveWithWarnings(dir, new Set(visited));
        warnings.push(...nestedWarnings);
        if (resolved) {
          // Replace the placeholder comment with resolved content
          const placeholder = dir.type === 'import'
            ? `<!-- @import:${dir.source}#${dir.section ?? ''} -->`
            : `<!-- @file:${dir.source}#${dir.section ?? ''} -->`; 
          compiled = compiled.replace(placeholder, resolved);
          resolvedDirectives.push(dir);
        } else {
          warnings.push(`Directive not resolved: ${dir.raw} at line ${dir.line}`);
        }
      } catch (err) {
        warnings.push(
          `Error resolving ${dir.raw} at line ${dir.line}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const result: CompileResult = {
      content: compiled,
      resolvedDirectives,
      warnings,
    };

    // Cache only top-level compilations (visited.size === 1 means this is the root)
    if (visited.size === 1) {
      this.cache.set(mdcName, result);
      this.writeDiskCacheEntry(mdcName, raw, directives, result);
    }

    return result;
  }

  /**
   * Compile ALL .mdc files and return deduplicated MdcChunk[].
   * Drop-in replacement for MdcChunker.chunkAll() with directive resolution.
   */
  compileAll(): MdcChunk[] {
    if (!fs.existsSync(this.rulesDir)) return [];

    const mdcFiles = fs.readdirSync(this.rulesDir)
      .filter((f) => f.endsWith('.mdc'))
      .map((f) => f.replace('.mdc', ''));

    const allChunks: MdcChunk[] = [];

    for (const name of mdcFiles) {
      const { content } = this.compile(name);
      if (!content.trim()) continue;

      // Use MdcChunker to produce hierarchical chunks from compiled content
      const relPath = `.cursor/rules/${name}.mdc`;
      const chunks = MdcChunker.chunkFile(content, relPath, `${name}.mdc`);
      allChunks.push(...chunks);
    }

    return this.deduplicate(allChunks);
  }

  /** Clear the in-memory and disk caches (e.g. after MDC file modifications) */
  clearCache(): void {
    this.cache.clear();
    this.diskCache = { version: 1, entries: {} };
    this.saveDiskCache();
  }

  // ── Private Methods ───────────────────────────────────────────────

  /**
   * Resolve a single directive to inlined content, propagating nested warnings.
   */
  private resolveDirectiveWithWarnings(
    directive: MdcDirective,
    visited: Set<string>,
  ): { resolved: string | null; nestedWarnings: string[] } {
    if (directive.type === 'import') {
      return this.resolveImportWithWarnings(directive, visited);
    } else if (directive.type === 'file') {
      return { resolved: this.resolveFile(directive), nestedWarnings: [] };
    }
    return { resolved: null, nestedWarnings: [] };
  }

  /**
   * Resolve @import(mdcName, "Section Title")
   * Compiles the referenced MDC, extracts the named section.
   * Propagates warnings from nested compilations.
   */
  private resolveImportWithWarnings(
    directive: MdcDirective,
    visited: Set<string>,
  ): { resolved: string | null; nestedWarnings: string[] } {
    const { content, warnings } = this.compile(directive.source, visited);
    const nestedWarnings = [...warnings];

    if (!content.trim()) return { resolved: null, nestedWarnings };

    if (directive.section) {
      const section = extractSection(content, directive.section);
      return { resolved: section || null, nestedWarnings };
    }

    return { resolved: content, nestedWarnings };
  }

  /**
   * Resolve @file(path, "key|section")
   * Reads the referenced file, extracts named section or JSON key.
   */
  private resolveFile(directive: MdcDirective): string | null {
    const resolvedPath = path.resolve(this.rulesDir, directive.source);

    // Security: prevent path traversal outside project root
    if (!resolvedPath.startsWith(this.projectRoot)) {
      return `<!-- @file blocked: path traversal outside project root -->`;
    }

    let fileContent: string;
    try {
      fileContent = fs.readFileSync(resolvedPath, 'utf-8');
    } catch {
      return null;
    }

    if (!directive.section) return fileContent;

    // Detect file type by extension
    const ext = path.extname(resolvedPath).toLowerCase();
    if (ext === '.json') {
      return extractJsonKey(fileContent, directive.section) || null;
    }

    // For markdown/text files, extract by heading
    return extractSection(fileContent, directive.section) || null;
  }

  /**
   * Strip YAML frontmatter from MDC content.
   */
  private stripFrontmatter(content: string): {
    frontmatter: string;
    body: string;
  } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return { frontmatter: '', body: content };
    return { frontmatter: match[1], body: match[2] };
  }

  /**
   * Deduplicate chunks by content similarity.
   * Uses first 200 chars of trimmed content as fingerprint.
   */
  private deduplicate(chunks: MdcChunk[]): MdcChunk[] {
    const seen = new Map<string, MdcChunk>();
    for (const chunk of chunks) {
      const key = `${chunk.level}:${chunk.content.trim().substring(0, 200)}`;
      if (!seen.has(key)) {
        seen.set(key, chunk);
      }
    }
    return Array.from(seen.values());
  }

  // ── Disk Cache Methods ──────────────────────────────────────────

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private loadDiskCache(): void {
    try {
      if (fs.existsSync(this.diskCachePath)) {
        const raw = fs.readFileSync(this.diskCachePath, 'utf-8');
        const parsed = JSON.parse(raw) as DiskCache;
        if (parsed.version === 1 && parsed.entries) {
          this.diskCache = parsed;
          return;
        }
      }
    } catch { /* corrupted cache — start fresh */ }
    this.diskCache = { version: 1, entries: {} };
  }

  private saveDiskCache(): void {
    if (!this.diskCache) return;
    try {
      // Atomic write-replace: write to .tmp first, then rename.
      // Prevents corrupted JSON from concurrent writes (CI pipelines, multiple MCP instances).
      const tmpPath = this.diskCachePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.diskCache), 'utf-8');
      fs.renameSync(tmpPath, this.diskCachePath);
    } catch { /* write failure is non-fatal */ }
  }

  /**
   * Check disk cache for a valid entry. Returns null if stale or missing.
   * Validates both the main file hash and all @import hashes.
   */
  private tryDiskCache(mdcName: string): CompileResult | null {
    if (!this.diskCache) return null;
    const entry = this.diskCache.entries[mdcName];
    if (!entry) return null;

    // Verify main file hash
    const filePath = path.join(this.rulesDir, `${mdcName}.mdc`);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    if (this.hashContent(raw) !== entry.hash) return null;

    // Verify all @import dependency hashes
    for (const [importName, expectedHash] of Object.entries(entry.importHashes)) {
      const importPath = path.join(this.rulesDir, `${importName}.mdc`);
      try {
        const importRaw = fs.readFileSync(importPath, 'utf-8');
        if (this.hashContent(importRaw) !== expectedHash) return null;
      } catch {
        return null; // imported file removed → stale
      }
    }

    return entry.result;
  }

  /**
   * Write a compile result to the disk cache with content hashes.
   */
  private writeDiskCacheEntry(
    mdcName: string,
    rawContent: string,
    directives: readonly MdcDirective[],
    result: CompileResult,
  ): void {
    if (!this.diskCache) return;

    // Collect hashes of @import dependencies
    const importHashes: Record<string, string> = {};
    for (const dir of directives) {
      if (dir.type === 'import') {
        const importPath = path.join(this.rulesDir, `${dir.source}.mdc`);
        try {
          const importRaw = fs.readFileSync(importPath, 'utf-8');
          importHashes[dir.source] = this.hashContent(importRaw);
        } catch { /* missing import — skip hash */ }
      }
    }

    this.diskCache.entries[mdcName] = {
      hash: this.hashContent(rawContent),
      importHashes,
      result,
    };
    this.saveDiskCache();
  }
}
