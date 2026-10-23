import { execFile as execFileCallback } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

import type {
  IWorkspaceIsolation,
  IsolatedWorkspace,
  IsolationTaskContext,
  WorkspaceMergeResult,
  WorkspaceVerifyResult,
} from '../../../domain/agents/IWorkspaceIsolation';
import type { CorrelationId } from '../../../core/types/branded';

type ExecFileResult = { stdout: string; stderr: string };
type ExecFileLike = (command: string, args: string[], options?: { cwd?: string }) => Promise<ExecFileResult>;

const execFileDefault = promisify(execFileCallback) as unknown as ExecFileLike;

export interface WorkspaceIsolationWorktreeAdapterOptions {
  readonly workspaceRoot: string;
  readonly execFile?: ExecFileLike;
  readonly now?: () => Date;
  readonly randomSuffix?: () => string;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
}

function parseShortStat(stdout: string): Pick<WorkspaceVerifyResult, 'filesChanged' | 'insertions' | 'deletions'> {
  const filesChanged = Number(stdout.match(/(\d+) file/)?.[1] ?? 0);
  const insertions = Number(stdout.match(/(\d+) insertion/)?.[1] ?? 0);
  const deletions = Number(stdout.match(/(\d+) deletion/)?.[1] ?? 0);
  return { filesChanged, insertions, deletions };
}

function mergeStats(
  left: Pick<WorkspaceVerifyResult, 'filesChanged' | 'insertions' | 'deletions'>,
  right: Pick<WorkspaceVerifyResult, 'filesChanged' | 'insertions' | 'deletions'>,
): Pick<WorkspaceVerifyResult, 'filesChanged' | 'insertions' | 'deletions'> {
  return {
    filesChanged: left.filesChanged + right.filesChanged,
    insertions: left.insertions + right.insertions,
    deletions: left.deletions + right.deletions,
  };
}

export class WorkspaceIsolationWorktreeAdapter implements IWorkspaceIsolation {
  private readonly workspaceRoot: string;
  private readonly execFile: ExecFileLike;
  private readonly now: () => Date;
  private readonly randomSuffix: () => string;

  constructor(options: WorkspaceIsolationWorktreeAdapterOptions) {
    this.workspaceRoot = normalizePath(options.workspaceRoot);
    this.execFile = options.execFile ?? execFileDefault;
    this.now = options.now ?? (() => new Date());
    this.randomSuffix = options.randomSuffix ?? (() => Math.random().toString(36).slice(2, 8));
  }

  async createIsolated(
    task: IsolationTaskContext,
    _correlationId: CorrelationId,
  ): Promise<IsolatedWorkspace> {
    const baseBranch = task.baseBranch ?? 'main';
    const workspaceId = `${task.taskId}-${this.randomSuffix()}`;

    if (task.strategy === 'none') {
      return {
        workspaceId,
        strategy: 'none',
        baseBranch,
        workingBranch: baseBranch,
        workdir: this.workspaceRoot,
        agentId: task.agentId,
        createdAt: this.now(),
        metadata: { mode: 'shared-workspace' },
      };
    }

    if (task.strategy === 'branch') {
      throw new Error('branch strategy is not implemented in WorkspaceIsolationWorktreeAdapter');
    }

    if (task.strategy === 'container') {
      throw new Error('container strategy is not implemented in WorkspaceIsolationWorktreeAdapter');
    }

    await this.execFile('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: this.workspaceRoot,
    });

    const suffix = workspaceId.split('-').pop() ?? this.randomSuffix();
    const branchName = sanitizeSegment(`${task.agentId}/${task.taskId}-${suffix}`);
    const workdir = normalizePath(
      path.join(this.workspaceRoot, '.microphoenix', 'worktrees', branchName.replace(/\//g, '-')),
    );

    await this.execFile('git', ['worktree', 'add', workdir, '-b', branchName, baseBranch], {
      cwd: this.workspaceRoot,
    });

    return {
      workspaceId,
      strategy: 'worktree',
      baseBranch,
      workingBranch: branchName,
      workdir,
      agentId: task.agentId,
      createdAt: this.now(),
      metadata: { requestedStrategy: task.strategy },
    };
  }

  async verify(
    workspace: IsolatedWorkspace,
    _correlationId: CorrelationId,
  ): Promise<WorkspaceVerifyResult> {
    if (workspace.strategy === 'none') {
      return {
        workspaceId: workspace.workspaceId,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        hasConflicts: false,
        conflictFiles: [],
        testsPassed: null,
      };
    }

    const workingTreeDiff = await this.execFile('git', ['-C', workspace.workdir, 'diff', '--shortstat'], {
      cwd: this.workspaceRoot,
    });
    const branchDiff = await this.execFile(
      'git',
      ['diff', '--shortstat', `${workspace.baseBranch}...${workspace.workingBranch}`],
      { cwd: this.workspaceRoot },
    );
    const stats = mergeStats(
      parseShortStat(branchDiff.stdout),
      parseShortStat(workingTreeDiff.stdout),
    );

    return {
      workspaceId: workspace.workspaceId,
      filesChanged: stats.filesChanged,
      insertions: stats.insertions,
      deletions: stats.deletions,
      hasConflicts: false,
      conflictFiles: [],
      testsPassed: null,
    };
  }

  async merge(
    workspace: IsolatedWorkspace,
    targetBranch: string,
    _correlationId: CorrelationId,
  ): Promise<WorkspaceMergeResult> {
    if (workspace.strategy === 'none') {
      return {
        workspaceId: workspace.workspaceId,
        outcome: 'success',
        targetBranch,
      };
    }

    try {
      const currentBranch = await this.execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.workspaceRoot,
      });
      const normalizedCurrentBranch = currentBranch.stdout.trim();
      if (normalizedCurrentBranch !== targetBranch) {
        return {
          workspaceId: workspace.workspaceId,
          outcome: 'failed',
          targetBranch,
          error: `target branch mismatch: expected ${targetBranch}, current branch is ${normalizedCurrentBranch}`,
        };
      }

      await this.execFile('git', ['merge', '--no-ff', workspace.workingBranch], {
        cwd: this.workspaceRoot,
      });

      return {
        workspaceId: workspace.workspaceId,
        outcome: 'success',
        targetBranch,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('CONFLICT')) {
        return {
          workspaceId: workspace.workspaceId,
          outcome: 'conflict',
          targetBranch,
          conflictFiles: [],
          error: message,
        };
      }

      return {
        workspaceId: workspace.workspaceId,
        outcome: 'failed',
        targetBranch,
        error: message,
      };
    }
  }

  async discard(
    workspace: IsolatedWorkspace,
    _correlationId: CorrelationId,
  ): Promise<void> {
    if (workspace.strategy === 'none') {
      return;
    }

    await this.execFile('git', ['worktree', 'remove', workspace.workdir, '--force'], {
      cwd: this.workspaceRoot,
    });
    await this.execFile('git', ['branch', '-D', workspace.workingBranch], {
      cwd: this.workspaceRoot,
    });
  }
}