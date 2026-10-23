/**
 * MCP Code Intelligence Server DI module.
 *
 * Registers:
 * 1. MCP Code Intelligence Server metadata (dev-time, for DI smoke tests)
 * 2. ICodeGraphStore port → shared runtime selector (KuzuDB when configured, InMemory fallback)
 * 3. ISearchAugmentationEngine port → SearchAugmentationAdapter binding
 * 4. IChangeImpactAnalyzer port → ChangeImpactAnalyzerAdapter binding
 * 5. IMroProcessor port → MroProcessorAdapter binding
 * 6. ICentralityScorer port → CentralityScorerAdapter binding
 * 7. IQueryClassificationVerifier port → QueryClassificationVerifierAdapter binding
 * 8. ITreeSitterParser port → TreeSitterParserAdapter binding (TS/JS AST-backed)
 * 9. IStaticCallGraphBuilder port → StaticCallGraphBuilderAdapter binding (TS/JS static analysis)
 * 10. ITypeEnvironment port → TypeEnvironmentAdapter (TypeScript checker, tiers 0–2)
 *
 * Layer: Infrastructure/DI
 * @see src/infrastructure/mcp/code-intelligence/MicroPhoenixMcpCodeIntelligenceServer.ts
 * @see src/domain/memory/ICodeGraphStore.ts
 * @see src/domain/memory/ISearchAugmentationEngine.ts
 * @see src/domain/memory/IChangeImpactAnalyzer.ts
 * @see src/domain/memory/IMroProcessor.ts
 * @see src/domain/memory/ICentralityScorer.ts
 * @see src/domain/memory/IQueryClassificationVerifier.ts
 * @see src/domain/memory/ITreeSitterParser.ts
 * @see src/domain/memory/IStaticCallGraphBuilder.ts
 * @see src/domain/memory/ITypeEnvironment.ts
 */

import { container } from '../../../core/di/container';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { createCodeGraphStoreFromEnv } from '../../memory/graph/code-graph-store.factory';

const log = getBootstrapLogger('mcp-code-intelligence');

export function registerMcpCodeIntelligenceModule(): void {
  if (container.isRegistered(DI_TOKENS.IMcpCodeIntelligenceServer)) return;

  try {
    container.register<{ name: string; version: string }>(
      DI_TOKENS.IMcpCodeIntelligenceServer,
      () => ({
        name: 'microphoenix-code-intelligence',
        version: '1.1.0',
      }),
      {
        lifecycle: 'singleton',
        tags: ['mcp', 'dev-tool', 'code-intelligence'],
        description: 'MCP Code Intelligence Server metadata (dev-time code graph tool)',
      },
    );

    // Wire ICodeGraphStore port → shared runtime selector to stay aligned with the main memory plane
    if (!container.isRegistered(DI_TOKENS.ICodeGraphStore)) {
      container.register(
        DI_TOKENS.ICodeGraphStore,
        () => createCodeGraphStoreFromEnv().store,
        {
          lifecycle: 'singleton',
          tags: ['memory', 'code-intelligence', 'graph'],
          description: 'Code Knowledge Graph adapter (KuzuDB when configured, in-memory fallback)',
        },
      );
    }

    // Wire ICodePathContextResolver port → CodePathContextResolverAdapter
    if (!container.isRegistered(DI_TOKENS.ICodePathContextResolver)) {
      const { CodePathContextResolverAdapter } = require('../../memory/graph/CodePathContextResolverAdapter');
      container.register(
        DI_TOKENS.ICodePathContextResolver,
        () => new CodePathContextResolverAdapter(
          container.resolve(DI_TOKENS.ITreeSitterParser),
          container.resolve(DI_TOKENS.ICodeGraphStore),
        ),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'code-intelligence', 'path-context'],
          description: 'Deterministic code-path context resolution from AST enclosure + graph snippets',
        },
      );
    }

    // Wire ISearchAugmentationEngine port → SearchAugmentationAdapter
    if (!container.isRegistered(DI_TOKENS.ISearchAugmentationEngine)) {
      const { SearchAugmentationAdapter } = require('../../memory/graph/SearchAugmentationAdapter');
      container.register(
        DI_TOKENS.ISearchAugmentationEngine,
        () => new SearchAugmentationAdapter(
          container.resolve(DI_TOKENS.ICodeGraphStore),
        ),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'code-intelligence', 'search'],
          description: 'Search result augmentation via Code Knowledge Graph',
        },
      );
    }

    // Wire IChangeImpactAnalyzer port → ChangeImpactAnalyzerAdapter
    if (!container.isRegistered(DI_TOKENS.IChangeImpactAnalyzer)) {
      const { ChangeImpactAnalyzerAdapter } = require('../../memory/graph/ChangeImpactAnalyzerAdapter');
      container.register(
        DI_TOKENS.IChangeImpactAnalyzer,
        () => new ChangeImpactAnalyzerAdapter(
          container.resolve(DI_TOKENS.ICodeGraphStore),
        ),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'code-intelligence', 'impact-analysis'],
          description: 'Git-diff-based change impact analysis via Code Knowledge Graph',
        },
      );
    }

    // Wire IMroProcessor port → MroProcessorAdapter
    if (!container.isRegistered(DI_TOKENS.IMroProcessor)) {
      const { MroProcessorAdapter } = require('../../memory/graph/MroProcessorAdapter');
      container.register(
        DI_TOKENS.IMroProcessor,
        () => new MroProcessorAdapter(),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'code-intelligence', 'mro'],
          description: 'Language-aware Method Resolution Order processor',
        },
      );
    }

    // Wire ICentralityScorer port → CentralityScorerAdapter
    if (!container.isRegistered(DI_TOKENS.ICentralityScorer)) {
      const { CentralityScorerAdapter } = require('../../memory/graph/CentralityScorerAdapter');
      container.register(
        DI_TOKENS.ICentralityScorer,
        () => new CentralityScorerAdapter(
          container.resolve(DI_TOKENS.ICodeGraphStore),
        ),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'code-intelligence', 'centrality'],
          description: 'Graph centrality analysis (PageRank, Betweenness, Degree)',
        },
      );
    }

    // Wire IQueryClassificationVerifier port → QueryClassificationVerifierAdapter
    if (!container.isRegistered(DI_TOKENS.IQueryClassificationVerifier)) {
      const { QueryClassificationVerifierAdapter } = require('../../memory/graph/QueryClassificationVerifierAdapter');
      container.register(
        DI_TOKENS.IQueryClassificationVerifier,
        (c) => new QueryClassificationVerifierAdapter(
          c.isRegistered(DI_TOKENS.IChatCompletionModel)
            ? c.resolve(DI_TOKENS.IChatCompletionModel)
            : undefined,
        ),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'code-intelligence', 'query-classification'],
          description: 'LLM shadow consensus for heuristic query classification verification',
        },
      );
    }

    // Wire ITreeSitterParser port → TreeSitterParserAdapter (TS/JS AST-backed)
    if (!container.isRegistered(DI_TOKENS.ITreeSitterParser)) {
      const { TreeSitterParserAdapter } = require('../../memory/graph/TreeSitterParserAdapter');
      container.register(
        DI_TOKENS.ITreeSitterParser,
        () => new TreeSitterParserAdapter(),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'code-intelligence', 'ast', 'tree-sitter'],
          description: 'TypeScript compiler-backed AST parser for TS/JS with explicit unsupported-language diagnostics',
        },
      );
    }

    // Wire IStaticCallGraphBuilder port → StaticCallGraphBuilderAdapter (TS/JS static analysis)
    if (!container.isRegistered(DI_TOKENS.IStaticCallGraphBuilder)) {
      const { StaticCallGraphBuilderAdapter } = require('../../memory/graph/StaticCallGraphBuilderAdapter');
      container.register(
        DI_TOKENS.IStaticCallGraphBuilder,
        () => new StaticCallGraphBuilderAdapter(),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'code-intelligence', 'call-graph'],
          description: 'Static call graph builder for TS/JS sources using parser-derived symbol and call-site data',
        },
      );
    }

    // Wire ITypeEnvironment port → TypeEnvironmentAdapter
    if (!container.isRegistered(DI_TOKENS.ITypeEnvironment)) {
      const { TypeEnvironmentAdapter } = require('../../memory/graph/TypeEnvironmentAdapter');
      container.register(
        DI_TOKENS.ITypeEnvironment,
        () => new TypeEnvironmentAdapter(),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'code-intelligence', 'type-resolution'],
          description: 'Type environment for TypeScript and JavaScript via the compiler checker',
        },
      );
    }

    log.info('✓ MCP Code Intelligence Server + 10 code graph ports registered');
  } catch (error) {
    log.error('✗ Failed to register MCP Code Intelligence Server:', { error });
    throw error;
  }
}
