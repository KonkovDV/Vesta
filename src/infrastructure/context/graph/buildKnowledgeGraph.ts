/**
 * buildKnowledgeGraph — Factory function to construct the full Knowledge Graph.
 *
 * Orchestrates all three builders (DI, AST, MDC) to populate a single
 * KnowledgeGraphEngine instance with the complete project structure.
 *
 * @layer Infrastructure/Context
 * @phase 5 — V3 Context Engineering: Knowledge Graph
 *
 * @example
 * ```typescript
 * import { buildKnowledgeGraph } from '@/infrastructure/context/graph/buildKnowledgeGraph';
 * const engine = buildKnowledgeGraph('/path/to/project');
 * const result = engine.query('What depends on IEventStore?');
 * ```
 */

import { KnowledgeGraphEngine } from './KnowledgeGraphEngine';
import { DiGraphBuilder } from './builders/DiGraphBuilder';
import { AstGraphBuilder } from './builders/AstGraphBuilder';
import { MdcGraphBuilder } from './builders/MdcGraphBuilder';
import { GlossaryGraphBuilder } from './builders/GlossaryGraphBuilder';

/**
 * Build the full Knowledge Graph from all four sources.
 *
 * Order matters for optimal edge resolution:
 * 1. DI tokens (creates token nodes that AST builder references)
 * 2. AST interfaces + implementations (creates interface nodes that MDC references)
 * 3. MDC rules (references tokens and interfaces)
 * 4. Glossary terms (references tokens and interfaces from SOTA_GLOSSARY_2026.md)
 */
export function buildKnowledgeGraph(projectRoot: string): KnowledgeGraphEngine {
  const engine = new KnowledgeGraphEngine();

  // Phase 1: DI token graph (fast — regex on one file)
  new DiGraphBuilder(projectRoot).build(engine);

  // Phase 2: AST interface/implementation graph (medium — scans src/)
  new AstGraphBuilder(projectRoot).build(engine);

  // Phase 3: MDC rule graph (fast — regex on 12 .mdc files)
  new MdcGraphBuilder(projectRoot).build(engine);

  // Phase 4: Glossary term graph (fast — regex on SOTA_GLOSSARY_2026.md)
  new GlossaryGraphBuilder(projectRoot).build(engine);

  return engine;
}
