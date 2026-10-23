/**
 * SearchAugmentationAdapter — Infrastructure implementation of ISearchAugmentationEngine.
 *
 * Enriches raw search results with structural context from the Code Knowledge Graph.
 * Delegates to ICodeGraphStore for symbol lookup, callers/callees, processes, and communities.
 *
 * Layer: Infrastructure
 * Pattern source: GitNexus v1.4.0 augmentation/engine.ts (U6, patterns only)
 */

import type {
  ISearchAugmentationEngine,
  RawSearchHit,
  AugmentedSearchResult,
  AugmentationConfig,
} from '../../../domain/memory/ISearchAugmentationEngine';
import type {
  ICodeGraphStore,
  CodeGraphNode,
  CodeProcess,
  CodeCommunity,
} from '../../../domain/memory/ICodeGraphStore';
import type { TenantId, CorrelationId } from '../../../domain/memory/session-types';

const DEFAULT_MAX_RELATIONS = 5;
const DEFAULT_MAX_PROCESSES = 3;

export class SearchAugmentationAdapter implements ISearchAugmentationEngine {
  constructor(private readonly graphStore: ICodeGraphStore) {}

  async augment(input: {
    tenantId: TenantId;
    hits: readonly RawSearchHit[];
    config?: AugmentationConfig;
    correlationId: CorrelationId;
  }): Promise<readonly AugmentedSearchResult[]> {
    const maxRelations = input.config?.maxRelations ?? DEFAULT_MAX_RELATIONS;
    const maxProcesses = input.config?.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    const includeCommunity = input.config?.includeCommunity ?? true;
    const includeImpact = input.config?.includeImpact ?? true;

    const results: AugmentedSearchResult[] = [];

    for (const hit of input.hits) {
      const symbols = await this.findSymbolsAtLocation(
        input.tenantId, hit.filePath, hit.line, input.correlationId,
      );

      let callers: CodeGraphNode[] = [];
      let callees: CodeGraphNode[] = [];
      let processes: CodeProcess[] = [];
      let community: CodeCommunity | undefined;
      let impactScore = 0;

      if (symbols.length > 0) {
        const primarySymbol = symbols[0];

        const context = await this.graphStore.getSymbolContext({
          tenantId: input.tenantId,
          symbolId: primarySymbol.id,
          correlationId: input.correlationId,
        });

        callers = context.callers.slice(0, maxRelations);
        callees = context.callees.slice(0, maxRelations);
        processes = context.processes.slice(0, maxProcesses);

        if (includeCommunity) {
          community = await this.findCommunityForSymbol(
            input.tenantId, primarySymbol.id, input.correlationId,
          );
        }

        if (includeImpact) {
          impactScore = await this.computeImpactScore(
            input.tenantId, primarySymbol.id, input.correlationId,
          );
        }
      }

      results.push({
        hit,
        symbols,
        callers,
        callees,
        processes,
        community,
        impactScore,
      });
    }

    return results;
  }

  private async findSymbolsAtLocation(
    tenantId: TenantId,
    filePath: string,
    line: number | undefined,
    correlationId: CorrelationId,
  ): Promise<CodeGraphNode[]> {
    const searchResults = await this.graphStore.hybridSearch({
      tenantId,
      query: filePath,
      limit: 20,
      correlationId,
    });

    return (searchResults as CodeGraphNode[]).filter(node => {
      if (node.filePath !== filePath) return false;
      if (line === undefined) return true;
      if (node.startLine !== undefined && node.endLine !== undefined) {
        return line >= node.startLine && line <= node.endLine;
      }
      return node.startLine === line;
    });
  }

  private async findCommunityForSymbol(
    tenantId: TenantId,
    symbolId: string,
    correlationId: CorrelationId,
  ): Promise<CodeCommunity | undefined> {
    const communities = await this.graphStore.getCommunities({
      tenantId,
      correlationId,
    });

    return (communities as CodeCommunity[]).find(
      c => c.members.includes(symbolId),
    );
  }

  private async computeImpactScore(
    tenantId: TenantId,
    symbolId: string,
    correlationId: CorrelationId,
  ): Promise<number> {
    const impact = await this.graphStore.analyzeImpact({
      tenantId,
      targetId: symbolId,
      direction: 'upstream',
      maxDepth: 3,
      correlationId,
    });

    const callerWeight = impact.summary.directCallers * 2;
    const processWeight = impact.summary.affectedProcesses * 3;
    const moduleWeight = impact.summary.affectedModules * 1;
    const raw = callerWeight + processWeight + moduleWeight;

    return Math.min(raw / 20, 1.0);
  }
}
