/**
 * GlossaryGraphBuilder — Populates Knowledge Graph from SOTA_GLOSSARY_2026.md.
 *
 * Parses the glossary SSOT to extract term definitions and creates
 * glossary_term nodes with 'defines' edges to referenced DI tokens and interfaces.
 *
 * @layer Infrastructure/Context
 * @phase 5.1 — V3 Context Engineering: Glossary Graph Integration (REC-03)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { KnowledgeGraphEngine } from '../KnowledgeGraphEngine';

// ── Types ───────────────────────────────────────────────────────────

export interface ParsedGlossaryTerm {
  readonly term: string;
  readonly definition: string;
  readonly section: string;
  readonly referencedTokens: readonly string[];
  readonly referencedInterfaces: readonly string[];
}

// ── Builder ─────────────────────────────────────────────────────────

export class GlossaryGraphBuilder {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Parse SOTA_GLOSSARY_2026.md and populate the graph with glossary_term nodes
   * and 'defines' edges to referenced tokens/interfaces.
   */
  build(engine: KnowledgeGraphEngine): void {
    const terms = this.parseGlossary();

    // Add a root category node for the glossary
    const glossaryRootId = 'layer:glossary';
    engine.addNode({
      id: glossaryRootId,
      type: 'layer',
      label: 'SOTA Glossary 2026',
      metadata: { termCount: terms.length },
    });

    for (const term of terms) {
      const termId = `glossary_term:${term.term}`;
      engine.addNode({
        id: termId,
        type: 'glossary_term',
        label: term.term,
        metadata: {
          definition: term.definition.slice(0, 200),
          section: term.section,
        },
      });

      // Edge: glossary root → term
      engine.addEdge({
        source: glossaryRootId,
        target: termId,
        relation: 'defines',
      });

      // Link to referenced DI tokens
      for (const tokenRef of term.referencedTokens) {
        const tokenId = `token:${tokenRef}`;
        engine.addEdge({
          source: termId,
          target: tokenId,
          relation: 'references',
        });
      }

      // Link to referenced interfaces
      for (const ifaceRef of term.referencedInterfaces) {
        const ifaceId = `interface:${ifaceRef}`;
        engine.addEdge({
          source: termId,
          target: ifaceId,
          relation: 'references',
        });
      }
    }
  }

  /**
   * Parse SOTA_GLOSSARY_2026.md extracting bold term names, definitions,
   * and referenced code entities.
   */
  parseGlossary(): ParsedGlossaryTerm[] {
    const filePath = path.join(this.projectRoot, '04-REFERENCE', 'SOTA_GLOSSARY_2026.md');
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    const terms: ParsedGlossaryTerm[] = [];
    let currentSection = '';

    const lines = content.split('\n');
    for (const line of lines) {
      // Section headers: ### A, ### B, etc.
      const sectionMatch = line.match(/^###\s+([A-Z])\s*$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        continue;
      }

      // Term entries: **TermName** — Definition text...
      // Also handles: **Term (Abbreviation)** — Definition...
      const termMatch = line.match(/^\*\*([^*]+)\*\*\s*—\s*(.+)/);
      if (termMatch) {
        const termName = termMatch[1].trim();
        const definition = termMatch[2].trim();

        // Extract referenced interfaces (IFooBar pattern)
        const ifaceRefs = new Set<string>();
        const ifacePattern = /\bI[A-Z][A-Za-z]+\b/g;
        let m: RegExpExecArray | null;
        while ((m = ifacePattern.exec(definition)) !== null) {
          ifaceRefs.add(m[0]);
        }

        // Extract referenced DI tokens from backtick-quoted identifiers
        const tokenRefs = new Set<string>();
        const tokenPattern = /`([A-Z][A-Za-z]+(?:Service|Store|Factory|Adapter|Provider|Guard|Pipeline|Runner|Executor|Monitor|Detector|Loader|Scanner|Registry|Compiler|Builder))`/g;
        while ((m = tokenPattern.exec(definition)) !== null) {
          tokenRefs.add(m[1]);
        }

        terms.push({
          term: termName,
          definition,
          section: currentSection,
          referencedTokens: [...tokenRefs],
          referencedInterfaces: [...ifaceRefs],
        });
      }
    }

    return terms;
  }
}
