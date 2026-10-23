/**
 * ChangeImpactAnalyzerAdapter — Infrastructure implementation of IChangeImpactAnalyzer.
 *
 * Maps git diff (changed files/lines) through the Code Knowledge Graph
 * to determine affected symbols, processes, modules, and overall risk.
 *
 * Layer: Infrastructure
 * Pattern source: GitNexus v1.4.0 mcp/tools.ts detect_changes (U17, patterns only)
 */

import type {
  IChangeImpactAnalyzer,
  FileChange,
  AffectedSymbol,
  ChangeImpactResult,
} from '../../../domain/memory/IChangeImpactAnalyzer';
import type {
  ICodeGraphStore,
  CodeGraphNode,
  CodeProcess,
  ImpactRiskLevel,
} from '../../../domain/memory/ICodeGraphStore';
import type { TenantId, CorrelationId } from '../../../domain/memory/session-types';

const DEFAULT_MAX_TRANSITIVE_DEPTH = 3;

export class ChangeImpactAnalyzerAdapter implements IChangeImpactAnalyzer {
  constructor(private readonly graphStore: ICodeGraphStore) {}

  async analyzeChanges(input: {
    tenantId: TenantId;
    changes: readonly FileChange[];
    maxTransitiveDepth?: number;
    correlationId: CorrelationId;
  }): Promise<ChangeImpactResult> {
    const maxDepth = input.maxTransitiveDepth ?? DEFAULT_MAX_TRANSITIVE_DEPTH;

    const directlyAffected: AffectedSymbol[] = [];
    const transitiveSet = new Map<string, CodeGraphNode>();
    const processSet = new Map<string, CodeProcess>();
    const moduleSet = new Set<string>();

    for (const change of input.changes) {
      const symbols = await this.findSymbolsInFile(
        input.tenantId, change, input.correlationId,
      );

      for (const affected of symbols) {
        directlyAffected.push(affected);
        moduleSet.add(this.extractModule(affected.node.filePath));

        const impact = await this.graphStore.analyzeImpact({
          tenantId: input.tenantId,
          targetId: affected.node.id,
          direction: 'upstream',
          maxDepth,
          correlationId: input.correlationId,
        });

        for (const [, nodes] of impact.byDepth) {
          for (const node of nodes) {
            if (!transitiveSet.has(node.id)) {
              transitiveSet.set(node.id, node);
              moduleSet.add(this.extractModule(node.filePath));
            }
          }
        }

        for (const processLabel of impact.affectedProcesses) {
          if (!processSet.has(processLabel)) {
            const processes = await this.graphStore.getProcesses({
              tenantId: input.tenantId,
              correlationId: input.correlationId,
            });
            const found = (processes as CodeProcess[]).find(p => p.label === processLabel);
            if (found) processSet.set(processLabel, found);
          }
        }
      }
    }

    const directCount = directlyAffected.length;
    const transitiveCount = transitiveSet.size;
    const processCount = processSet.size;
    const moduleCount = moduleSet.size;

    const overallRisk = this.classifyOverallRisk(
      directCount, transitiveCount, processCount,
    );

    return {
      directlyAffected,
      transitivelyAffected: [...transitiveSet.values()],
      affectedProcesses: [...processSet.values()],
      affectedModules: [...moduleSet],
      overallRisk,
      summary: { directCount, transitiveCount, processCount, moduleCount },
    };
  }

  private async findSymbolsInFile(
    tenantId: TenantId,
    change: FileChange,
    correlationId: CorrelationId,
  ): Promise<AffectedSymbol[]> {
    const nodes = await this.graphStore.hybridSearch({
      tenantId,
      query: change.filePath,
      limit: 50,
      correlationId,
    });

    const fileNodes = (nodes as CodeGraphNode[]).filter(
      n => n.filePath === change.filePath,
    );

    if (change.changeType === 'deleted') {
      return fileNodes.map(node => ({
        node,
        changeType: 'deleted' as const,
        overlapLines: (node.endLine ?? node.startLine ?? 0) - (node.startLine ?? 0) + 1,
      }));
    }

    if (!change.changedLines || change.changedLines.length === 0) {
      return fileNodes.map(node => ({
        node,
        changeType: change.changeType === 'added' ? 'body_changed' as const : 'modified' as const,
        overlapLines: 0,
      }));
    }

    const affected: AffectedSymbol[] = [];
    for (const node of fileNodes) {
      const overlap = this.computeOverlap(node, change.changedLines);
      if (overlap > 0) {
        const changeType = this.inferChangeType(node, change.changedLines);
        affected.push({ node, changeType, overlapLines: overlap });
      }
    }
    return affected;
  }

  private computeOverlap(
    node: CodeGraphNode,
    changedLines: readonly { start: number; end: number }[],
  ): number {
    if (node.startLine === undefined || node.endLine === undefined) return 0;

    let overlap = 0;
    for (const range of changedLines) {
      const overlapStart = Math.max(node.startLine, range.start);
      const overlapEnd = Math.min(node.endLine, range.end);
      if (overlapStart <= overlapEnd) {
        overlap += overlapEnd - overlapStart + 1;
      }
    }
    return overlap;
  }

  private inferChangeType(
    node: CodeGraphNode,
    changedLines: readonly { start: number; end: number }[],
  ): 'modified' | 'signature_changed' | 'body_changed' {
    if (node.startLine === undefined) return 'modified';

    for (const range of changedLines) {
      if (range.start <= node.startLine && range.end >= node.startLine) {
        return 'signature_changed';
      }
    }
    return 'body_changed';
  }

  private extractModule(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const srcIndex = parts.indexOf('src');
    if (srcIndex >= 0 && srcIndex + 2 < parts.length) {
      return `${parts[srcIndex + 1]}/${parts[srcIndex + 2]}`;
    }
    return parts.slice(-2, -1).join('/') || 'unknown';
  }

  private classifyOverallRisk(
    direct: number,
    transitive: number,
    processes: number,
  ): ImpactRiskLevel {
    const score = direct * 3 + transitive * 1 + processes * 5;
    if (score >= 30) return 'CRITICAL';
    if (score >= 15) return 'HIGH';
    if (score >= 5) return 'MEDIUM';
    return 'LOW';
  }
}
