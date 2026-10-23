/**
 * Batch Tool Executor Adapter — pipelined multi-call execution.
 *
 * Resolves dependency graph (topological sort), respects fail-fast
 * semantics, enforces per-call and batch-level timeouts.
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-005 Programmatic Tool Calling / Batch Execution (FITNESS-K: 81.0)
 * @see src/domain/agents/IBatchToolExecutor.ts — domain port
 * @see src/domain/security/tool-execution-policy.interface.ts — per-call policy
 */

import type { CorrelationId } from '../../core/types/branded';
import type {
  IBatchToolExecutor,
  BatchExecutionRequest,
  BatchExecutionResult,
  BatchPolicyDecision,
  BatchCallResult,
  BatchCallOutcome,
  BatchOutcome,
  BatchToolCall,
} from '../../domain/agents/IBatchToolExecutor';
import type {
  IToolExecutionPolicy,
  ToolExecutionRequest,
} from '../../domain/security/tool-execution-policy.interface';
import type { IToolRegistry } from '../../domain/agents/tools.interface';
import type { IAgentContext } from '../../domain/agents/agent-context.interface';

// ── Minimal Logger ────────────────────────────────────────────────

interface BatchLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── Adapter ───────────────────────────────────────────────────────

export class BatchToolExecutorAdapter implements IBatchToolExecutor {
  /** Active batches for abort tracking. */
  private readonly activeBatches = new Map<string, { aborted: boolean }>();

  constructor(
    private readonly logger?: BatchLogger,
    private readonly toolPolicy?: IToolExecutionPolicy,
    private readonly tools?: Pick<IToolRegistry, 'execute'>,
  ) {}

  async executeBatch(
    request: BatchExecutionRequest,
    correlationId: CorrelationId,
  ): Promise<BatchExecutionResult> {
    const startMs = Date.now();
    const failFast = request.failFast ?? true;
    const results: BatchCallResult[] = [];
    const completedCalls = new Map<string, BatchCallResult>();
    const deniedCallReasons = new Map<string, string>();
    const heldCallReasons = new Map<string, string>();

    const policyDecision = await this.evaluateBatchPolicy(request, correlationId);
    for (const callDecision of policyDecision.callDecisions) {
      if (callDecision.decision === 'deny') {
        deniedCallReasons.set(
          callDecision.callId,
          callDecision.reason ?? 'Blocked by tool execution policy',
        );
      } else if (callDecision.decision === 'ask') {
        heldCallReasons.set(
          callDecision.callId,
          callDecision.reason ?? 'approval required',
        );
      }
    }

    this.activeBatches.set(request.batchId, { aborted: false });

    this.logger?.info('Batch execution started', {
      batchId: request.batchId,
      agentId: request.agentId,
      callCount: request.calls.length,
      failFast,
      correlationId,
    });

    // Topological ordering based on dependsOn
    const ordered = this.topologicalSort(request.calls);

    let hasFailure = false;

    try {
      for (const call of ordered) {
        // Check abort
        if (this.activeBatches.get(request.batchId)?.aborted) {
          results.push(this.makeSkippedResult(call, 'Batch aborted'));
          continue;
        }

        // Check batch duration
        if (request.maxBatchDurationMs && (Date.now() - startMs) >= request.maxBatchDurationMs) {
          results.push(this.makeSkippedResult(call, 'Batch duration exceeded'));
          continue;
        }

        // Fail-fast: skip remaining if a previous call failed
        if (hasFailure && failFast) {
          results.push(this.makeSkippedResult(call, 'Skipped due to fail-fast'));
          continue;
        }

        const heldReason = heldCallReasons.get(call.callId);
        if (heldReason) {
          results.push(this.makeSkippedResult(call, heldReason));
          completedCalls.set(call.callId, results[results.length - 1]);
          hasFailure = true;
          continue;
        }

        const deniedReason = deniedCallReasons.get(call.callId);
        if (deniedReason) {
          const result: BatchCallResult = {
            callId: call.callId,
            toolName: call.toolName,
            outcome: 'error',
            error: deniedReason,
            durationMs: 0,
          };
          results.push(result);
          completedCalls.set(call.callId, result);
          hasFailure = true;
          continue;
        }

        // Check conditionalOn: skip if prerequisite did not succeed
        if (call.conditionalOn) {
          const prereq = completedCalls.get(call.conditionalOn);
          if (!prereq || prereq.outcome !== 'success') {
            const result: BatchCallResult = {
              callId: call.callId,
              toolName: call.toolName,
              outcome: 'skipped',
              error: `Condition not met: ${call.conditionalOn} did not succeed`,
              durationMs: 0,
            };
            results.push(result);
            completedCalls.set(call.callId, result);
            continue;
          }
        }

        // Check dependsOn: all must have succeeded
        if (call.dependsOn?.length) {
          const unmetDep = call.dependsOn.find(depId => {
            const dep = completedCalls.get(depId);
            return !dep || dep.outcome !== 'success';
          });
          if (unmetDep) {
            const result: BatchCallResult = {
              callId: call.callId,
              toolName: call.toolName,
              outcome: 'skipped',
              error: `Dependency not met: ${unmetDep}`,
              durationMs: 0,
            };
            results.push(result);
            completedCalls.set(call.callId, result);
            continue;
          }
        }

        const callStart = Date.now();
        let outcome: BatchCallOutcome = 'success';
        let output: unknown;
        let error: string | undefined;

        try {
          output = await this.invokeTool(call, request);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          outcome = message === 'Call timed out' ? 'timeout' : 'error';
          error = message;
          hasFailure = true;
        }

        const callResult: BatchCallResult = {
          callId: call.callId,
          toolName: call.toolName,
          outcome,
          output,
          error,
          durationMs: Date.now() - callStart,
        };

        results.push(callResult);
        completedCalls.set(call.callId, callResult);
      }
    } finally {
      this.activeBatches.delete(request.batchId);
    }

    const succeededCount = results.filter(r => r.outcome === 'success').length;
    const failedCount = results.filter(r => r.outcome === 'error' || r.outcome === 'timeout').length;
    const skippedCount = results.filter(r => r.outcome === 'skipped').length;

    const batchOutcome: BatchOutcome =
      succeededCount === results.length ? 'all_succeeded' :
      failedCount === results.length ? 'all_failed' :
      this.activeBatches.get(request.batchId)?.aborted ? 'aborted' :
      'partial';

    const executionResult: BatchExecutionResult = {
      batchId: request.batchId,
      outcome: batchOutcome,
      results,
      totalDurationMs: Date.now() - startMs,
      succeededCount,
      failedCount,
      skippedCount,
    };

    this.logger?.info('Batch execution completed', {
      batchId: request.batchId,
      outcome: batchOutcome,
      succeeded: succeededCount,
      failed: failedCount,
      skipped: skippedCount,
      correlationId,
    });

    return executionResult;
  }

  async evaluateBatchPolicy(
    request: BatchExecutionRequest,
    correlationId: CorrelationId,
  ): Promise<BatchPolicyDecision> {
    // FP-02 Phase 1: iterate calls and delegate to IToolExecutionPolicy per call
    const callDecisions: Array<{
      readonly callId: string;
      readonly decision: 'allow' | 'ask' | 'deny';
      readonly reason?: string;
    }> = [];
    const rejectedCallIds: string[] = [];

    for (const call of request.calls) {
      if (this.toolPolicy) {
        const policyRequest: ToolExecutionRequest = {
          toolName: call.toolName,
          arguments: call.args,
          agentId: request.agentId,
          traceId: correlationId,
        };
        const result = await this.toolPolicy.evaluate(policyRequest);

        if (!result.allowed) {
          callDecisions.push({
            callId: call.callId,
            decision: 'deny',
            reason: result.reason,
          });
          rejectedCallIds.push(call.callId);
          this.logger?.warn('Batch call denied by policy', {
            batchId: request.batchId,
            callId: call.callId,
            toolName: call.toolName,
            reason: result.reason,
            violationCode: result.violationCode,
            correlationId,
          });
        } else if (result.requiresApproval === true) {
          callDecisions.push({
            callId: call.callId,
            decision: 'ask',
            reason: result.approvalReason ?? result.reason ?? 'approval required',
          });
          this.logger?.warn('Batch call held for approval', {
            batchId: request.batchId,
            callId: call.callId,
            toolName: call.toolName,
            reason: result.approvalReason ?? result.reason,
            correlationId,
          });
        } else {
          callDecisions.push({
            callId: call.callId,
            decision: 'allow',
          });
        }
      } else {
        // No policy injected — allow (graceful degradation)
        callDecisions.push({
          callId: call.callId,
          decision: 'allow',
        });
      }
    }

    const awaitingApproval = callDecisions.some((decision) => decision.decision === 'ask');
    const allowed = rejectedCallIds.length === 0 && !awaitingApproval;

    this.logger?.info('Batch policy evaluated', {
      batchId: request.batchId,
      allowed,
      callCount: request.calls.length,
      rejectedCount: rejectedCallIds.length,
      correlationId,
    });

    return { allowed, callDecisions, rejectedCallIds };
  }

  async abortBatch(batchId: string, correlationId: CorrelationId): Promise<void> {
    const state = this.activeBatches.get(batchId);
    if (state) {
      state.aborted = true;
      this.logger?.info('Batch abort requested', { batchId, correlationId });
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  private async invokeTool(call: BatchToolCall, request: BatchExecutionRequest): Promise<unknown> {
    if (!this.tools) {
      throw new Error('Tool registry is not configured');
    }
    const context: IAgentContext = {
      agentId: request.agentId,
      sessionId: request.batchId,
      config: {},
      workspaceRoot: '',
    };
    const run = this.tools.execute(call.toolName, call.args, context);
    if (!call.timeoutMs || call.timeoutMs <= 0) {
      return run;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Call timed out')), call.timeoutMs);
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private topologicalSort(calls: ReadonlyArray<BatchToolCall>): BatchToolCall[] {
    const callMap = new Map(calls.map(c => [c.callId, c]));
    const visited = new Set<string>();
    const sorted: BatchToolCall[] = [];

    const visit = (callId: string): void => {
      if (visited.has(callId)) return;
      visited.add(callId);
      const call = callMap.get(callId);
      if (!call) return;
      for (const dep of call.dependsOn ?? []) {
        visit(dep);
      }
      sorted.push(call);
    };

    for (const call of calls) {
      visit(call.callId);
    }

    return sorted;
  }

  private makeSkippedResult(call: BatchToolCall, reason: string): BatchCallResult {
    return {
      callId: call.callId,
      toolName: call.toolName,
      outcome: 'skipped',
      error: reason,
      durationMs: 0,
    };
  }
}
