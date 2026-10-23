/**
 * CheckpointableFlowAdapter — Infrastructure adapter for ICheckpointableFlow.
 *
 * Provides in-memory checkpoint storage for multi-step flow crash recovery.
 * In production, this would be backed by IEventStore or a persistent store;
 * for now, uses a Map<flowId, FlowCheckpoint> for correctness.
 *
 * Best Practices Applied (March 2026):
 * - correlationId in all log entries (Hard Rule #6)
 * - TODO: Emit agentic.checkpoint.saved / agentic.checkpoint.resumed events via IEventStore
 *
 * DI: constructor(logger) — 1 arg
 *
 * @layer Infrastructure (implements Domain port)
 * @see ICheckpointableFlow (src/domain/execution/checkpointable-flow.interface.ts)
 * @see Book Ch.12 "Exception Handling and Recovery" — checkpoint/resume
 */

import type {
  ICheckpointableFlow,
  FlowCheckpoint,
} from '../../domain/execution/checkpointable-flow.interface';
import type { IAgentEventStream } from '../../domain/agents/IAgentEventStream';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

export class CheckpointableFlowAdapter implements ICheckpointableFlow {
  private readonly checkpoints = new Map<string, FlowCheckpoint>();
  private readonly flowSessions = new Map<string, string>();

  constructor(
    private readonly logger: ILogger,
    private readonly agentEventStream?: IAgentEventStream,
  ) {}

  async saveCheckpoint(
    checkpoint: FlowCheckpoint,
    correlationId: CorrelationId,
  ): Promise<void> {
    this.checkpoints.set(checkpoint.flowId, checkpoint);
    this.recordCheckpointAction(checkpoint.flowId, {
      event: 'checkpoint_saved',
      correlationId,
      stepIndex: checkpoint.stepIndex,
    });

    this.logger.info('Checkpoint saved', {
      correlationId,
      flowId: checkpoint.flowId,
      stepIndex: checkpoint.stepIndex,
    });
  }

  async loadCheckpoint(
    flowId: string,
    correlationId: CorrelationId,
  ): Promise<FlowCheckpoint | null> {
    const checkpoint = this.checkpoints.get(flowId) ?? null;
    this.recordCheckpointAction(flowId, {
      event: 'checkpoint_loaded',
      correlationId,
      found: checkpoint !== null,
      stepIndex: checkpoint?.stepIndex,
    });

    this.logger.debug('Checkpoint loaded', {
      correlationId,
      flowId,
      found: checkpoint !== null,
      stepIndex: checkpoint?.stepIndex,
    });

    return checkpoint;
  }

  async resumeFromCheckpoint(
    checkpoint: FlowCheckpoint,
    correlationId: CorrelationId,
  ): Promise<void> {
    this.recordCheckpointAction(checkpoint.flowId, {
      event: 'checkpoint_resumed',
      correlationId,
      fromStepIndex: checkpoint.stepIndex,
    });

    this.logger.info('Resuming from checkpoint', {
      correlationId,
      flowId: checkpoint.flowId,
      fromStepIndex: checkpoint.stepIndex,
    });
  }

  async clearCheckpoints(
    flowId: string,
    correlationId: CorrelationId,
  ): Promise<void> {
    this.checkpoints.delete(flowId);
    this.recordCheckpointAction(flowId, {
      event: 'checkpoint_cleared',
      correlationId,
    });
    this.closeCheckpointSession(flowId);

    this.logger.debug('Checkpoints cleared', {
      correlationId,
      flowId,
    });
  }

  private recordCheckpointAction(flowId: string, payload: Record<string, unknown>): void {
    const sessionId = this.ensureCheckpointSession(flowId);
    if (!sessionId) {
      return;
    }
    this.agentEventStream?.recordAction(sessionId, 'agent_message', {
      flowId,
      ...payload,
    });
  }

  private ensureCheckpointSession(flowId: string): string | undefined {
    if (!this.agentEventStream) {
      return undefined;
    }
    const existing = this.flowSessions.get(flowId);
    if (existing) {
      return existing;
    }
    const session = this.agentEventStream.createSession('checkpoint-flow', `checkpoint-flow:${flowId}`, {
      flowId,
    });
    this.flowSessions.set(flowId, session.sessionId);
    return session.sessionId;
  }

  private closeCheckpointSession(flowId: string): void {
    const sessionId = this.flowSessions.get(flowId);
    if (!sessionId || !this.agentEventStream) {
      return;
    }
    this.agentEventStream.closeSession(sessionId, 'completed');
    this.flowSessions.delete(flowId);
  }
}
