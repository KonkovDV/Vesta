/**
 * MdcGraphBuilder — Populates Knowledge Graph from MDC rule files.
 *
 * Parses `.cursor/rules/*.mdc` files to extract:
 * - MDC rule nodes (one per file)
 * - Glob patterns → layer associations (applies_to edges)
 * - Token/interface references within rule content (references edges)
 *
 * @layer Infrastructure/Context
 * @phase 5 — V3 Context Engineering: Knowledge Graph
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { KnowledgeGraphEngine } from '../KnowledgeGraphEngine';

// ── Builder ─────────────────────────────────────────────────────────

export class MdcGraphBuilder {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Parse all .mdc files and add rule nodes + edges to the graph.
   */
  build(engine: KnowledgeGraphEngine): void {
    const rulesDir = path.join(this.projectRoot, '.cursor', 'rules');
    if (!fs.existsSync(rulesDir)) return;

    const mdcFiles = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.mdc'));

    for (const file of mdcFiles) {
      const filePath = path.join(rulesDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const name = file.replace('.mdc', '');

      this.addRuleNode(engine, name, content, file);
    }
  }

  private addRuleNode(
    engine: KnowledgeGraphEngine,
    name: string,
    content: string,
    filename: string,
  ): void {
    const { frontmatter, body } = this.stripFrontmatter(content);
    const ruleId = `mdc_rule:${name}`;

    // Parse frontmatter for globs and description
    const globs = this.extractGlobs(frontmatter);
    const description = this.extractFmField(frontmatter, 'description');
    const alwaysApply = frontmatter.includes('alwaysApply: true');

    engine.addNode({
      id: ruleId,
      type: 'mdc_rule',
      label: name,
      metadata: {
        file: `.cursor/rules/${filename}`,
        description,
        globs,
        alwaysApply,
        contentLength: body.length,
      },
    });

    // Link to layers based on glob patterns
    const layers = this.globsToLayers(globs);
    for (const layer of layers) {
      const layerId = `layer:${layer}`;
      if (!engine.hasNode(layerId)) {
        engine.addNode({
          id: layerId,
          type: 'layer',
          label: layer,
          metadata: {},
        });
      }
      engine.addEdge({
        source: ruleId,
        target: layerId,
        relation: 'applies_to',
      });
    }

    // Extract entity references (IFoo, DI_TOKENS.X)
    const refs = this.extractReferences(body);
    for (const ref of refs) {
      const tokenId = `token:${ref}`;
      engine.addEdge({
        source: ruleId,
        target: tokenId,
        relation: 'references',
      });
    }
  }

  /**
   * Convert glob patterns to architectural layer names.
   */
  private globsToLayers(globs: string[]): string[] {
    const layers = new Set<string>();
    for (const glob of globs) {
      if (glob.includes('domain')) layers.add('domain');
      if (glob.includes('core')) layers.add('core');
      if (glob.includes('application')) layers.add('application');
      if (glob.includes('infrastructure')) layers.add('infrastructure');
      if (glob.includes('monitoring')) layers.add('monitoring');
      // Broad globs like src/**/*.ts apply to all
      if (/^src\/\*\*/.test(glob)) {
        layers.add('domain');
        layers.add('core');
        layers.add('application');
        layers.add('infrastructure');
      }
    }
    return Array.from(layers);
  }

  /**
   * Extract DI token and interface references from MDC body text.
   */
  private extractReferences(body: string): string[] {
    const refs = new Set<string>();

    // DI_TOKENS.XyzAbc references
    const diTokenMatches = body.match(/DI_TOKENS\.(\w+)/g);
    if (diTokenMatches) {
      for (const match of diTokenMatches) {
        refs.add(match.replace('DI_TOKENS.', ''));
      }
    }

    // Interface references: IFooBar (with word boundaries)
    const ifaceMatches = body.match(/\bI[A-Z][A-Za-z]+\b/g);
    if (ifaceMatches) {
      for (const match of ifaceMatches) {
        // Skip common false positives
        if (!['ID', 'IDs', 'If', 'In', 'Is', 'It', 'I'].includes(match) && match.length > 2) {
          refs.add(match);
        }
      }
    }

    return Array.from(refs);
  }

  private stripFrontmatter(content: string): { frontmatter: string; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return { frontmatter: '', body: content };
    return { frontmatter: match[1], body: match[2] };
  }

  private extractGlobs(frontmatter: string): string[] {
    const globs: string[] = [];
    // Single-line: globs: src/**
    const singleMatch = frontmatter.match(/^globs:\s*"?([^"\n]+)"?\s*$/m);
    if (singleMatch) {
      globs.push(singleMatch[1].trim());
      return globs;
    }
    // Multi-line YAML array
    const lines = frontmatter.split('\n');
    let inGlobs = false;
    for (const line of lines) {
      if (/^globs:\s*$/.test(line)) {
        inGlobs = true;
        continue;
      }
      if (inGlobs) {
        const itemMatch = line.match(/^\s+-\s+(.+)$/);
        if (itemMatch) {
          globs.push(itemMatch[1].trim());
        } else if (/^\w/.test(line)) {
          break; // Next YAML key
        }
      }
    }
    return globs;
  }

  private extractFmField(frontmatter: string, field: string): string {
    const match = frontmatter.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?`, 'm'));
    return match ? match[1].trim() : '';
  }
}
