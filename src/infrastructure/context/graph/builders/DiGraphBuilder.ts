/**
 * DiGraphBuilder — Populates Knowledge Graph from DI token registry.
 *
 * Parses `DI_TOKENS.ts` to extract token definitions (with JSDoc categorization),
 * then maps each token to its category and adds module→token→interface edges.
 *
 * Uses regex-based parsing (same approach as InterfaceIndexer) for speed —
 * no ts-morph needed for a flat constant object.
 *
 * @layer Infrastructure/Context
 * @phase 5 — V3 Context Engineering: Knowledge Graph
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { KnowledgeGraphEngine } from '../KnowledgeGraphEngine';

// ── Types ───────────────────────────────────────────────────────────

export interface ParsedToken {
  readonly name: string;
  readonly value: string;
  readonly category: string;
  readonly docRef?: string;
}

// ── Builder ─────────────────────────────────────────────────────────

export class DiGraphBuilder {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Parse DI_TOKENS.ts and populate the graph with token nodes and
   * category → token edges.
   */
  build(engine: KnowledgeGraphEngine): void {
    const tokens = this.parseTokens();
    const categories = new Map<string, ParsedToken[]>();

    // Group tokens by category
    for (const token of tokens) {
      const cat = token.category;
      if (!categories.has(cat)) categories.set(cat, []);
      categories.get(cat)!.push(token);
    }

    // Add layer nodes for each category
    for (const [category, catTokens] of categories) {
      const catId = `di_category:${category}`;
      engine.addNode({
        id: catId,
        type: 'layer',
        label: category,
        metadata: { tokenCount: catTokens.length },
      });

      // Add token nodes and edges
      for (const token of catTokens) {
        const tokenId = `token:${token.value}`;
        if (!engine.hasNode(tokenId)) {
          engine.addNode({
            id: tokenId,
            type: 'token',
            label: token.value,
            metadata: { name: token.name, docRef: token.docRef },
          });
        }

        engine.addEdge({
          source: catId,
          target: tokenId,
          relation: 'registers',
        });

        // If token name starts with "I" it probably maps to an interface
        if (token.value.startsWith('I') && token.value.length > 1 && /^[A-Z]/.test(token.value[1])) {
          const ifaceId = `interface:${token.value}`;
          if (!engine.hasNode(ifaceId)) {
            engine.addNode({
              id: ifaceId,
              type: 'interface',
              label: token.value,
              metadata: { fromDiToken: true },
            });
          }
          engine.addEdge({
            source: tokenId,
            target: ifaceId,
            relation: 'resolves',
          });
        }
      }
    }
  }

  /**
   * Parse DI_TOKENS.ts extracting token names, values, and category comments.
   */
  parseTokens(): ParsedToken[] {
    const filePath = path.join(this.projectRoot, 'src', 'core', 'di', 'DI_TOKENS.ts');
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    const tokens: ParsedToken[] = [];
    let currentCategory = 'Uncategorized';

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Category comment: `// Category Name`
      const catMatch = line.match(/^\s*\/\/\s*(.+?)\s*$/);
      if (catMatch) {
        const text = catMatch[1].trim();
        // Skip JSDoc-style and ignore single-character comments
        if (text.length > 2 && !text.startsWith('*') && !text.startsWith('@')) {
          currentCategory = text;
        }
      }

      // Token definition: `TokenName: 'TokenValue' as const,`
      const tokenMatch = line.match(/^\s+(\w+):\s*'([^']+)'\s+as\s+const\s*[,;]?\s*$/);
      if (tokenMatch) {
        // Look back for @see doc reference
        let docRef: string | undefined;
        if (i > 0) {
          const prevLine = lines[i - 1];
          const seeMatch = prevLine.match(/@see\s+docs?:\s*(.+)/);
          if (seeMatch) docRef = seeMatch[1].trim();
        }

        tokens.push({
          name: tokenMatch[1],
          value: tokenMatch[2],
          category: currentCategory,
          docRef,
        });
      }
    }

    return tokens;
  }
}
