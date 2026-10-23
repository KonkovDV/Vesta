/**
 * IWorkspaceIsolation — Domain port for ephemeral workspace isolation.
 *
 * Provides agent-level filesystem isolation via git worktrees (or alternative
 * strategies). Each agent operates in its own isolated workspace, preventing
 * cross-contamination of changes until consensus/verification confirms quality.
 *
 * @layer Domain (port contract)
 * @pattern CC-008 Worktree Isolation (FITNESS-K: 89.0)
 * @see claude-code-best-practice: isolation: worktree parameter
 * @see src/domain/agents/IOrchestrationPipeline.ts — orchestration creates isolated workspaces
 * @see src/domain/security/path-boundary-enforcer.port.ts — path security within workspace
 * @module agents
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Strategy for isolating an agent's workspace.
 *
 * - worktree: git worktree (recommended, parallel branches with shared .git)
 * - branch: separate branch without worktree (sequential, lighter)
 * - container: full container isolation (heaviest, maximum security)
 * - none: no isolation (read-only tasks, analysis)
 */
export type WorkspaceIsolationStrategy = 'worktree' | 'branch' | 'container' | 'none';

/**
 * Describes an isolated workspace created for an agent.
 */
export interface IsolatedWorkspace {
  readonly workspaceId: string;
  readonly strategy: WorkspaceIsolationStrategy;
  readonly baseBranch: string;
  readonly workingBranch: string;
  readonly workdir: string;
  readonly agentId: string;
  readonly createdAt: Date;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Task context used to create an isolated workspace.
 */
export interface IsolationTaskContext {
  readonly taskId: string;
  readonly agentId: string;
  readonly description: string;
  readonly strategy: WorkspaceIsolationStrategy;
  readonly baseBranch?: string;
}

/**
 * Result of verifying changes in an isolated workspace.
 */
export interface WorkspaceVerifyResult {
  readonly workspaceId: string;
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly hasConflicts: boolean;
  readonly conflictFiles: readonly string[];
  readonly testsPassed: boolean | null;
}

/**
 * Result of merging an isolated workspace back to the target branch.
 */
export type MergeOutcome = 'success' | 'conflict' | 'aborted' | 'failed';

export interface WorkspaceMergeResult {
  readonly workspaceId: string;
  readonly outcome: MergeOutcome;
  readonly targetBranch: string;
  readonly mergeCommit?: string;
  readonly conflictFiles?: readonly string[];
  readonly error?: string;
}

// ── Interface ──────────────────────────────────────────────────────

/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface IWorkspaceIsolation {
  /**
   * Create an isolated workspace for an agent task.
   * For worktree strategy: creates a git worktree + temp branch.
   * For branch strategy: creates a new branch from base.
   * For none strategy: returns the current workspace as-is.
   *
   * @param task - Context describing the task and isolation requirements
   * @param correlationId - Request correlation for tracing
   * @returns The created isolated workspace descriptor
   */
  createIsolated(
    task: IsolationTaskContext,
    correlationId: CorrelationId,
  ): Promise<IsolatedWorkspace>;

  /**
   * Verify changes made in an isolated workspace: diff stats,
   * conflict detection, and optional test execution.
   *
   * @param workspace - The isolated workspace to verify
   * @param correlationId - Request correlation for tracing
   * @returns Verification result with diff stats and conflict info
   */
  verify(
    workspace: IsolatedWorkspace,
    correlationId: CorrelationId,
  ): Promise<WorkspaceVerifyResult>;

  /**
   * Merge changes from an isolated workspace into the target branch.
   * Fails cleanly on conflicts without corrupting the target.
   *
   * @param workspace - The isolated workspace to merge
   * @param targetBranch - The branch to merge into
   * @param correlationId - Request correlation for tracing
   * @returns Merge result with outcome and optional conflict details
   */
  merge(
    workspace: IsolatedWorkspace,
    targetBranch: string,
    correlationId: CorrelationId,
  ): Promise<WorkspaceMergeResult>;

  /**
   * Discard an isolated workspace and clean up resources.
   * For worktree: removes the worktree directory and temp branch.
   *
   * @param workspace - The isolated workspace to discard
   * @param correlationId - Request correlation for tracing
   */
  discard(
    workspace: IsolatedWorkspace,
    correlationId: CorrelationId,
  ): Promise<void>;
}
