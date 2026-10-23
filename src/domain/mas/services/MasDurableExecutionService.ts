/**
 * MAS Durable Execution - core service.
 *
 * Layer: Domain Service (pure domain logic for MAS durable execution).
 *
 * Responsibilities:
 * - provide a small façade over MasExecutionStore for MAS runtime;
 * - encapsulate common patterns for starting tasks/steps and
 *   completing/failing steps;
 * - keep all persistence details delegated to MasExecutionStore
 *   (and its infra implementations using IEventStore/Outbox).
 */

import { IdGenerator } from '../../../core/utils/IdGenerator';
import type { MasExecutionStore } from '../MasExecutionStore';
import type { MasTaskExecution } from '../MasTaskExecution';
import type { MasTaskExecutionInit } from '../MasTaskExecutionInit';
import type { MasExecutionStep } from '../MasExecutionStep';
import type { MasStepDescriptor } from '../MasStepDescriptor';
import type { MasStepStatusUpdate } from '../MasStepStatusUpdate';
import { MasExecutionStatus } from '../MasExecutionStatus';
import type { MasExecutionError } from '../MasExecutionError';
import type { MasResultRef } from '../MasResultRef';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { IRequestContext } from '../../../core/context/IRequestContext';

/**
 * Descriptor for starting a new durable task execution.
 *
 * This is a thin alias over MasTaskExecutionInit to keep the
 * service API self-describing while reusing the domain DTO.
 */
export type MasTaskDescriptor = MasTaskExecutionInit;

/**
 * Metadata describing a successful step completion.
 *
 * The durable engine treats these fields as hints for
 * MasExecutionStore.updateStepStatus().
 */
export interface MasStepResultMeta {
  resultRef?: MasResultRef;
  completedAt?: Date;
  lastHeartbeatAt?: Date;
  meta?: Record<string, unknown>;
}

export class MasDurableExecutionService {
  constructor(
    private readonly executionStore: MasExecutionStore,
    private readonly logger?: ILogger
  ) {}

  /**
   * Create a new durable task execution instance using the underlying
   * MasExecutionStore.
   */
  async startNewTask(descriptor: MasTaskDescriptor): Promise<MasTaskExecution> {
    const correlationId = descriptor.requestContextSnapshot?.correlationId;
    
    this.logger?.log('Starting new MAS Durable Task', {
      taskId: descriptor.taskId,
      masSessionId: descriptor.sessionId,
      correlationId,
      meta: descriptor.meta,
    });

    try {
      const execution = await this.executionStore.startTaskExecution(descriptor);
      this.logger?.debug('MAS Durable Task started successfully', {
        taskId: descriptor.taskId,
        taskExecutionId: execution.taskExecutionId,
        correlationId,
      });
      return execution;
    } catch (error) {
      this.logger?.error('Failed to start MAS Durable Task', {
        taskId: descriptor.taskId,
        error,
        correlationId,
      });
      throw error;
    }
  }

  /**
   * Append and start a new execution step for the given task.
   *
   * The new step is created in InProgress state with attempts = 0
   * and an auto-generated stepId/index.
   */
  async startStep(
    taskExecutionId: string,
    stepDescriptor: MasStepDescriptor,
    requestContext: IRequestContext
  ): Promise<MasExecutionStep> {
    const correlationId = requestContext.getCorrelationId();
    const masTraceId = requestContext.getMasTraceId?.() || undefined;

    this.logger?.debug('Starting MAS Durable Step', {
      taskExecutionId,
      kind: stepDescriptor.kind,
      correlationId,
      masTraceId,
    });

    const taskExecution = await this.executionStore.getTaskExecution(
      taskExecutionId,
    );

    if (!taskExecution) {
      const errorMsg = `MasDurableExecutionService.startStep: taskExecution ${taskExecutionId} not found`;
      this.logger?.error(errorMsg, { taskExecutionId, correlationId });
      throw new Error(errorMsg);
    }

    const index = taskExecution.steps.length;
    const now = new Date();
    const stepId = this.generateStepId(taskExecutionId, index);

    const step: MasExecutionStep = {
      stepId,
      taskExecutionId,
      index,
      kind: stepDescriptor.kind,
      status: MasExecutionStatus.InProgress,
      attempts: 0,
      maxAttempts: stepDescriptor.maxAttempts,
      idempotencyKey: stepDescriptor.idempotencyKey,
      inputSnapshot: stepDescriptor.inputSnapshot,
      resultRef: undefined,
      error: undefined,
      startedAt: now,
      completedAt: undefined,
      lastHeartbeatAt: now,
      memoryPolicy: stepDescriptor.memoryPolicy,
      policyDecisionRef: undefined,
    };

    const updatedExecution = await this.executionStore.appendStep(
      taskExecutionId,
      step,
    );

    const persisted = updatedExecution.steps.find(s => s.stepId === stepId);
    
    this.logger?.log('MAS Durable Step started', {
      taskExecutionId,
      stepId,
      index,
      kind: stepDescriptor.kind,
      correlationId,
    });

    return persisted ?? step;
  }

  /**
   * Mark the given step as Completed and optionally attach a result
   * reference/metadata.
   */
  async completeStep(
    taskExecutionId: string,
    stepId: string,
    result: MasStepResultMeta = {},
    requestContext: IRequestContext
  ): Promise<MasTaskExecution> {
    const now = new Date();
    const correlationId = requestContext.getCorrelationId();
    const masTraceId = requestContext.getMasTraceId?.() || undefined;

    this.logger?.debug('Completing MAS Durable Step', {
      taskExecutionId,
      stepId,
      correlationId,
      masTraceId,
    });

    const update: MasStepStatusUpdate = {
      taskExecutionId,
      stepId,
      status: MasExecutionStatus.Completed,
      error: null,
      resultRef: result.resultRef,
      completedAt: result.completedAt ?? now,
      lastHeartbeatAt: result.lastHeartbeatAt ?? now,
      meta: result.meta,
    };

    const updated = await this.executionStore.updateStepStatus(update);
    
    this.logger?.log('MAS Durable Step completed', {
      taskExecutionId,
      stepId,
      matchFound: !!updated, // crude check, updated is MasTaskExecution
      correlationId,
    });

    return updated;
  }

  /**
   * Mark the given step as Failed with a durable error.
   */
  async failStep(
    taskExecutionId: string,
    stepId: string,
    error: MasExecutionError,
    requestContext: IRequestContext
  ): Promise<MasTaskExecution> {
    const now = new Date();
    const correlationId = requestContext?.getCorrelationId?.() || undefined;

    this.logger?.warn('Failing MAS Durable Step', {
      taskExecutionId,
      stepId,
      errorCode: error.code,
      errorMessage: error.message,
      correlationId,
    });

    const update: MasStepStatusUpdate = {
      taskExecutionId,
      stepId,
      status: MasExecutionStatus.Failed,
      error,
      completedAt: now,
      lastHeartbeatAt: now,
    };

    return this.executionStore.updateStepStatus(update);
  }

  /**
   * Mark the given step as Blocked with a durable error.
   *
   * Blocked means the step is currently unable to make progress due to
   * external conditions (e.g. CIRCUIT_OPEN), but is not considered a
   * terminal failure and may be retried/unblocked in the future.
   *
   * NOTE:
   * - completedAt is intentionally left undefined so that recovery logic
   *   can treat Blocked steps as "live" and apply CIRCUIT_OPEN-specific
   *   policies instead of generic failure handling.
   */
  async blockStep(
    taskExecutionId: string,
    stepId: string,
    error: MasExecutionError,
    requestContext: IRequestContext
  ): Promise<MasTaskExecution> {
    const now = new Date();
    const correlationId = requestContext?.getCorrelationId?.() || undefined;

    this.logger?.warn('Blocking MAS Durable Step', {
      taskExecutionId,
      stepId,
      errorCode: error.code,
      errorMessage: error.message,
      correlationId,
    });

    const update: MasStepStatusUpdate = {
      taskExecutionId,
      stepId,
      status: MasExecutionStatus.Blocked,
      error,
      completedAt: undefined,
      lastHeartbeatAt: now,
    };

    return this.executionStore.updateStepStatus(update);
  }

  private generateStepId(taskExecutionId: string, index: number): string {
    const random = IdGenerator.generateRandomString(12);
    return `mas_step_${taskExecutionId}_${index}_${random}`;
  }
}
