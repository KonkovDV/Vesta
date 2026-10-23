/**
 * IntentGraphAnalyzerAdapter — In-memory file-graph proximity analysis for silent drift.
 *
 * @layer Infrastructure (Security)
 * @pattern CC-029 Intent Graph Analyzer (PUA v5.2 → IBAC 3.0)
 * @see src/domain/security/IIntentGraphAnalyzer.ts — domain port
 */

import type {
  IIntentGraphAnalyzer,
  FileProximity,
  TaskGraphNode,
  ProximityCheckResult,
  IntentGraphConfig,
  IntentGraphStats,
} from '../../domain/security/IIntentGraphAnalyzer';
import { DEFAULT_INTENT_GRAPH_CONFIG } from '../../domain/security/IIntentGraphAnalyzer';

// ── Logger ────────────────────────────────────────────────────────

interface GraphLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Adapter ───────────────────────────────────────────────────────

export class IntentGraphAnalyzerAdapter implements IIntentGraphAnalyzer {
  private readonly nodes = new Map<string, TaskGraphNode>();
  private readonly edges = new Map<string, Set<string>>();
  private taskDescription = '';
  private checksPerformed = 0;
  private silentDriftCount = 0;
  private backtrackCount = 0;
  private consecutiveDrifts = 0;
  private readonly proximityCounts: Record<FileProximity, number> = {
    core: 0, adjacent: 0, distant: 0, unrelated: 0,
  };

  constructor(private readonly logger?: GraphLogger) {}

  initializeTaskGraph(taskFiles: readonly string[], taskDescription: string): void {
    this.reset();
    this.taskDescription = taskDescription;

    for (const file of taskFiles) {
      const normalized = this.normalize(file);
      this.nodes.set(normalized, {
        filePath: normalized,
        hopDistance: 0,
        proximity: 'core',
        source: 'declared',
      });
    }

    this.logger?.info('Task graph initialized', {
      taskFiles: taskFiles.length,
      taskDescription,
    });
  }

  addDependencyEdge(fromFile: string, toFile: string): void {
    const from = this.normalize(fromFile);
    const to = this.normalize(toFile);

    if (!this.edges.has(from)) this.edges.set(from, new Set());
    this.edges.get(from)!.add(to);

    // If fromFile is in the graph, add toFile with hop+1
    const fromNode = this.nodes.get(from);
    if (fromNode && !this.nodes.has(to)) {
      this.nodes.set(to, {
        filePath: to,
        hopDistance: fromNode.hopDistance + 1,
        proximity: this.classifyProximity(fromNode.hopDistance + 1),
        source: 'import_chain',
      });
    }
  }

  checkFileAccess(
    filePath: string,
    config: IntentGraphConfig = DEFAULT_INTENT_GRAPH_CONFIG,
  ): ProximityCheckResult {
    const normalized = this.normalize(filePath);
    this.checksPerformed++;

    const existingNode = this.nodes.get(normalized);
    let hopDistance: number;
    let proximity: FileProximity;
    let nearestTaskFile: string | undefined;

    if (existingNode) {
      hopDistance = existingNode.hopDistance;
      proximity = existingNode.proximity;
    } else if (config.useDirectoryProximity) {
      // Directory-based proximity fallback
      const result = this.calculateDirectoryProximity(normalized, config);
      hopDistance = result.hops;
      proximity = result.proximity;
      nearestTaskFile = result.nearest;

      // Add to graph as agent_access
      this.nodes.set(normalized, {
        filePath: normalized,
        hopDistance,
        proximity,
        source: 'agent_access',
      });
    } else {
      hopDistance = -1;
      proximity = 'unrelated';
    }

    const silentDriftDetected = proximity === 'distant' || proximity === 'unrelated';
    if (silentDriftDetected) {
      this.silentDriftCount++;
      this.consecutiveDrifts++;
    } else {
      this.consecutiveDrifts = 0;
    }

    const backtrackRecommended = this.consecutiveDrifts >= config.backtrackAfterDrifts;
    if (backtrackRecommended) {
      this.backtrackCount++;
    }

    this.proximityCounts[proximity]++;

    const analysis = this.buildAnalysis(normalized, proximity, hopDistance, silentDriftDetected, backtrackRecommended);

    if (silentDriftDetected) {
      this.logger?.warn('Silent drift detected', {
        filePath: normalized,
        proximity,
        hopDistance,
        consecutiveDrifts: this.consecutiveDrifts,
        backtrackRecommended,
      });
    }

    return {
      filePath: normalized,
      proximity,
      hopDistance,
      silentDriftDetected,
      backtrackRecommended,
      nearestTaskFile,
      analysis,
      checkedAt: new Date().toISOString(),
    };
  }

  getTaskGraph(): readonly TaskGraphNode[] {
    return [...this.nodes.values()];
  }

  getStats(): IntentGraphStats {
    return {
      graphSize: this.nodes.size,
      checksPerformed: this.checksPerformed,
      silentDriftCount: this.silentDriftCount,
      backtrackCount: this.backtrackCount,
      checksByProximity: { ...this.proximityCounts },
    };
  }

  reset(): void {
    this.nodes.clear();
    this.edges.clear();
    this.taskDescription = '';
    this.checksPerformed = 0;
    this.silentDriftCount = 0;
    this.backtrackCount = 0;
    this.consecutiveDrifts = 0;
    this.proximityCounts.core = 0;
    this.proximityCounts.adjacent = 0;
    this.proximityCounts.distant = 0;
    this.proximityCounts.unrelated = 0;
    this.logger?.info('Intent Graph Analyzer reset');
  }

  // ── Private Helpers ─────────────────────────────────────────

  private normalize(path: string): string {
    return path.replace(/\\/g, '/');
  }

  private classifyProximity(
    hops: number,
    config: IntentGraphConfig = DEFAULT_INTENT_GRAPH_CONFIG,
  ): FileProximity {
    if (hops === 0) return 'core';
    if (hops <= config.adjacentMaxHops) return 'adjacent';
    if (hops <= config.distantMaxHops) return 'distant';
    return 'unrelated';
  }

  private calculateDirectoryProximity(
    filePath: string,
    config: IntentGraphConfig,
  ): { hops: number; proximity: FileProximity; nearest?: string } {
    let minDist = Infinity;
    let nearest: string | undefined;

    for (const [nodePath] of this.nodes) {
      const dist = this.directoryDistance(filePath, nodePath);
      if (dist < minDist) {
        minDist = dist;
        nearest = nodePath;
      }
    }

    if (minDist === Infinity) {
      return { hops: -1, proximity: 'unrelated' };
    }

    // Map directory distance to hop equivalent
    const hops = Math.ceil(minDist / 2);
    return {
      hops,
      proximity: this.classifyProximity(hops, config),
      nearest,
    };
  }

  private directoryDistance(a: string, b: string): number {
    const aParts = a.split('/');
    const bParts = b.split('/');

    let common = 0;
    for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
      if (aParts[i] === bParts[i]) common++;
      else break;
    }

    return (aParts.length - common) + (bParts.length - common);
  }

  private buildAnalysis(
    filePath: string,
    proximity: FileProximity,
    hops: number,
    drift: boolean,
    backtrack: boolean,
  ): string {
    const parts = [`File "${filePath}" classified as ${proximity} (hop distance: ${hops})`];
    if (drift) parts.push('SILENT DRIFT detected — file is semantically distant from task scope');
    if (backtrack) parts.push(`BACKTRACK recommended — ${this.consecutiveDrifts} consecutive drifts exceed threshold`);
    if (!drift) parts.push('File is within task scope');
    return parts.join('. ');
  }
}
