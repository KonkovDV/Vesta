/**
 * ITreeOfThoughts — LATS (Language Agent Tree Search) Domain Port
 *
 * Replaces linear ReAct reasoning with tree-structured exploration:
 * Generator → Evaluator/Critic → Selector → Backpropagation.
 *
 * @layer Domain
 * @pattern Pillar-3 LATS (Zhou et al. 2024, arXiv:2310.04406)
 * @see Zhou et al. "Language Agent Tree Search" (arXiv:2310.04406, 2024)
 * @see Yao et al. "Tree of Thoughts" (NeurIPS 2023, arXiv:2305.10601)
 * @FITNESS-K 94.0
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ────────────────────────────────────────────────────────────────────

export type TreeNodeState = 'pending' | 'evaluated' | 'selected' | 'pruned';

export interface TreeNodeMetadata {
  readonly modelUsed: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly generationDurationMs: number;
  readonly evaluationDurationMs?: number;
}

export interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly action: string;
  readonly state: TreeNodeState;
  /** Critic evaluation score [0.0, 1.0] */
  readonly score: number;
  readonly evaluationRationale: string;
  readonly children: readonly string[];
  readonly metadata: TreeNodeMetadata;
}

export type SelectionStrategy = 'best-first' | 'mcts' | 'beam-search';

export interface TreeSearchConfig {
  readonly maxDepth: number;
  readonly branchingFactor: number;
  readonly maxTotalNodes: number;
  /** Minimum score to keep a node (below → prune) */
  readonly pruneThreshold: number;
  readonly selectionStrategy: SelectionStrategy;
  readonly criticModel?: string;
  readonly tokenBudget?: number;
}

export interface TreeSearchResult {
  readonly selectedPath: readonly TreeNode[];
  readonly totalNodesExplored: number;
  readonly totalNodesPruned: number;
  readonly totalTokensUsed: number;
  readonly searchDurationMs: number;
  readonly confidenceScore: number;
  readonly allPaths: readonly (readonly TreeNode[])[];
}

// ── Interface ────────────────────────────────────────────────────────────────

export interface ITreeOfThoughts {
  /**
   * Execute tree search for a task.
   * Generates multiple solution paths, evaluates via Critic,
   * returns the highest-scoring path.
   */
  search(
    task: string,
    context: string,
    config: TreeSearchConfig,
    correlationId: CorrelationId,
  ): Promise<TreeSearchResult>;

  /**
   * Evaluate a single node using the Critic model.
   */
  evaluateNode(
    node: TreeNode,
    context: string,
    correlationId: CorrelationId,
  ): Promise<TreeNode>;

  /**
   * Expand a node by generating child branches.
   */
  expandNode(
    parent: TreeNode,
    branchingFactor: number,
    correlationId: CorrelationId,
  ): Promise<TreeNode[]>;
}
