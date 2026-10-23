/**
 * IIntentGraphAnalyzer — Domain port for graph-based intent proximity analysis.
 *
 * CC-029 Intent Graph Analyzer: extends CC-026 (IntentMisalignmentDetector) with
 * file-dependency-graph analysis for "Silent Drift" detection. While CC-026
 * evaluates individual tool calls via keyword Jaccard similarity, CC-029 maintains
 * a task-scoped file proximity graph and detects when an agent accesses files that
 * are semantically distant from the task's file neighborhood.
 *
 * Key Innovation: File Graph Proximity
 *   - Builds a task-scoped subgraph of files relevant to the current task
 *   - Each new file access is evaluated for proximity to the task graph
 *   - Distant files trigger "Silent Drift" alerts even when individual tool calls appear aligned
 *   - Proximity calculated via import/dependency chains, directory distance, and co-change history
 *
 * Silent Drift Detection:
 *   Agent says "fixing DI bootstrap" → touches bootstrap.ts (close, OK)
 *     → reads DI_TOKENS.ts (1-hop, OK)
 *     → edits EventBus.ts (2-hops, WARNING — adjacent subsystem)
 *     → reads PromptInjectionScanner.ts (distant, BACKTRACK — unrelated subsystem)
 *
 * Integration Points:
 *   - IIntentMisalignmentDetector (CC-026) — tool-level analysis; this adds file-level
 *   - IExecutionProvenanceTracer (CC-019) — file citation tracking feeds the graph
 *   - ICbvShadowAuditor (CC-022) — silent drift findings feed CBV evidence chain
 *
 * Academic Basis:
 *   - Epistemic Context Learning (arXiv:2601.21742, Jan 2026) — peer reliability estimation
 *   - Taming OpenClaw (arXiv:2603.11619, Mar 2026) — lifecycle intent security, stage 3 inference
 *   - Epistemic Stability (arXiv:2603.10047, Mar 2026) — M4 Enhanced Data Registry
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-029 Intent Graph Analyzer (PUA v5.2 → IBAC 3.0)
 * @see src/domain/security/IIntentMisalignmentDetector.ts — CC-026 tool-level detector
 * @see src/domain/security/ISemanticProximityProvider.ts — CC-029+ vector augmentation
 */

// ── Types ──────────────────────────────────────────────────────────

/** Proximity level of a file to the task graph. */
export type FileProximity = 'core' | 'adjacent' | 'distant' | 'unrelated';

/** A file node in the task proximity graph. */
export interface TaskGraphNode {
  /** File path. */
  readonly filePath: string;
  /** Hop distance from declared task files (0 = declared, 1 = direct import, etc.). */
  readonly hopDistance: number;
  /** Proximity classification. */
  readonly proximity: FileProximity;
  /** How this file was added to the graph (declared, imported, accessed). */
  readonly source: 'declared' | 'import_chain' | 'agent_access';
}

/** Result of a file access proximity check. */
export interface ProximityCheckResult {
  /** The file being checked. */
  readonly filePath: string;
  /** Proximity to the task graph. */
  readonly proximity: FileProximity;
  /** Hop distance (-1 if not in graph). */
  readonly hopDistance: number;
  /** Whether this triggers a silent drift alert. */
  readonly silentDriftDetected: boolean;
  /** Whether backtracking is recommended. */
  readonly backtrackRecommended: boolean;
  /** Nearest related task file (if any). */
  readonly nearestTaskFile?: string;
  /** Human-readable analysis. */
  readonly analysis: string;
  /** Timestamp. */
  readonly checkedAt: string;
  /** Semantic distance [0, 1] when ISemanticProximityProvider is available. */
  readonly semanticDistance?: number;
}

/** Configuration for the intent graph analyzer. */
export interface IntentGraphConfig {
  /** Maximum hop distance for 'adjacent' classification (default: 2). */
  readonly adjacentMaxHops: number;
  /** Maximum hop distance for 'distant' classification (default: 4). */
  readonly distantMaxHops: number;
  /** Number of silent drift detections before recommending backtrack (default: 2). */
  readonly backtrackAfterDrifts: number;
  /** Whether to use directory proximity as fallback when import chain is unavailable (default: true). */
  readonly useDirectoryProximity: boolean;
  /** When true and ISemanticProximityProvider is injected, blend semantic similarity. */
  readonly useSemanticProximity: boolean;
  /** Weight for semantic vs structural proximity [0, 1]. 1.0 = pure semantic. */
  readonly semanticWeight: number;
}

/** Default configuration. */
export const DEFAULT_INTENT_GRAPH_CONFIG: IntentGraphConfig = {
  adjacentMaxHops: 2,
  distantMaxHops: 4,
  backtrackAfterDrifts: 2,
  useDirectoryProximity: true,
  useSemanticProximity: false,
  semanticWeight: 0.3,
};

/** Statistics about graph analysis. */
export interface IntentGraphStats {
  /** Number of nodes in the task graph. */
  readonly graphSize: number;
  /** Number of file access checks performed. */
  readonly checksPerformed: number;
  /** Number of silent drift detections. */
  readonly silentDriftCount: number;
  /** Number of backtrack recommendations. */
  readonly backtrackCount: number;
  /** Checks by proximity level. */
  readonly checksByProximity: Record<FileProximity, number>;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Intent Graph Analyzer — file-dependency-graph proximity analysis for silent drift.
 *
 * Maintains a task-scoped file proximity graph and evaluates each file access
 * for semantic distance from the task neighborhood.
 */
export interface IIntentGraphAnalyzer {
  /**
   * Initialize the task graph with the declared task files.
   *
   * @param taskFiles - File paths declared as part of the current task
   * @param taskDescription - Description of the task (for logging)
   */
  initializeTaskGraph(taskFiles: readonly string[], taskDescription: string): void;

  /**
   * Add an import/dependency edge to the graph.
   *
   * @param fromFile - Source file
   * @param toFile - Imported/dependent file
   */
  addDependencyEdge(fromFile: string, toFile: string): void;

  /**
   * Check the proximity of a file access to the task graph.
   *
   * @param filePath - The file being accessed
   * @param config - Graph analysis configuration
   * @returns Proximity check result
   */
  checkFileAccess(filePath: string, config?: IntentGraphConfig): ProximityCheckResult;

  /**
   * Get the current task graph state.
   *
   * @returns All nodes in the task graph
   */
  getTaskGraph(): readonly TaskGraphNode[];

  /**
   * Get statistics about graph analysis.
   *
   * @returns Graph usage statistics
   */
  getStats(): IntentGraphStats;

  /** Reset the graph and all state. */
  reset(): void;
}
