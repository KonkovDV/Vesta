/**
 * MAS Runtime Core - TaskDecomposerV1 implementation.
 *
 * Layer: Application (business orchestration).
 *
 * MAS-A1.4 scope:
 * - pure deterministic task decomposition logic;
 * - no direct I/O (Memory/LLM/network/Outbox/monitoring);
 * - constructs a minimal MasTaskPlan for MasterAgent.
 */
import type {
  MasTaskPlan,
  MasTask,
  MasTaskType,
  MasTaskStatus,
  TaskRuntimeConstraints,
  TaskDecompositionInput,
  MasTaskId,
  AgentCapability,
  MasRequest,
  MasSessionContext,
  MasMetadataBag,
} from '../types/mas-types';
import type { ITaskDecomposer } from '../core/task-decomposer';

const DEFAULT_MAX_DURATION_MS = 60_000;
const DEFAULT_MAX_COST_UNITS = 1;

/**
 * Basic deterministic implementation of ITaskDecomposer.
 *
 * The strategy in v1 is intentionally simple:
 * - a single MasTask per MasRequest;
 * - task type is inferred from scenario/useCase keywords;
 * - basic runtime constraints are applied uniformly;
 * - metadata is enriched with request and session fields.
 */
export class TaskDecomposerV1 implements ITaskDecomposer {
  async decomposeTask(input: TaskDecompositionInput): Promise<MasTaskPlan> {
    this.assertValidInput(input);

    const { request, session } = input;

    const taskId = this.generateTaskId(1);
    const taskType = this.inferTaskType(request);
    const taskDescription = this.buildTaskDescription(request);
    const taskStatus: MasTaskStatus = 'pending';
    const taskConstraints = this.buildConstraints();
    const taskCapabilities = this.buildRequiredCapabilities(request);
    const taskMetadata = this.buildTaskMetadata(request);

    const task: MasTask = {
      id: taskId,
      description: taskDescription,
      type: taskType,
      status: taskStatus,
      dependsOn: [],
      preferredAgentRole: undefined,
      requiredCapabilities: taskCapabilities,
      constraints: taskConstraints,
      metadata: taskMetadata,
    };

    const planMetadata = this.buildPlanMetadata(session);

    const plan: MasTaskPlan = {
      tasks: [task],
      entryTaskIds: [taskId],
      metadata: planMetadata,
    };

    return plan;
  }

  private assertValidInput(input: TaskDecompositionInput | null | undefined): void {
    if (!input || !input.request || !input.session) {
      throw new Error('TaskDecomposerV1: invalid input');
    }
  }

  private generateTaskId(counter: number): MasTaskId {
    // For v1 we use a simple deterministic pattern scoped to a single plan.
    return `task-${counter}` as MasTaskId;
  }

  private inferTaskType(request: MasRequest): MasTaskType {
    const textParts: string[] = [];

    if (request.useCase) {
      textParts.push(request.useCase);
    }

    if (request.scenario) {
      textParts.push(request.scenario);
    }

    const combined = textParts.join(' ').toLowerCase();

    if (
      combined.includes('analysis') ||
      combined.includes('analyze') ||
      combined.includes('audit')
    ) {
      return 'analysis';
    }

    if (combined.includes('plan') || combined.includes('design')) {
      return 'planning';
    }

    if (combined.includes('execute') || combined.includes('run')) {
      return 'execution';
    }

    return 'other';
  }

  private buildTaskDescription(request: MasRequest): string {
    const scenario = request.scenario ?? 'default';
    const useCasePart = request.useCase
      ? ` and useCase "${request.useCase}"`
      : '';

    return `Handle MAS request for scenario "${scenario}"${useCasePart}`;
  }

  private buildConstraints(): TaskRuntimeConstraints {
    return {
      maxDurationMs: DEFAULT_MAX_DURATION_MS,
      maxCostUnits: DEFAULT_MAX_COST_UNITS,
      // deadlineAt is intentionally left undefined in v1.
    };
  }

  private buildRequiredCapabilities(request: MasRequest): AgentCapability[] {
    const tag =
      request.scenario?.trim() ||
      request.useCase?.trim() ||
      'generic_assistant';

    const capability: AgentCapability = {
      tag,
    };

    return [capability];
  }

  private buildTaskMetadata(
    request: MasRequest,
  ): MasMetadataBag | undefined {
    const metadata: MasMetadataBag = {
      scenario: request.scenario,
      useCase: request.useCase,
    };

    if (typeof request.payload !== 'undefined') {
      metadata.payloadType = this.describePayloadType(request.payload);

      const preview = this.buildPayloadPreview(request.payload);
      if (typeof preview !== 'undefined') {
        metadata.payloadPreview = preview;
      }

      if (request.payload && typeof request.payload === 'object') {
        metadata.payloadKeys = this.extractPayloadKeys(
          request.payload as MasMetadataBag,
        );
      }
    }

    return metadata;
  }

  private describePayloadType(payload: unknown): string {
    if (payload === null) {
      return 'null';
    }

    if (Array.isArray(payload)) {
      return 'array';
    }

    return typeof payload;
  }

  private buildPayloadPreview(payload: unknown): string | undefined {
    if (payload === null || typeof payload === 'undefined') {
      return undefined;
    }

    if (typeof payload === 'string') {
      return payload;
    }

    try {
      const json = JSON.stringify(payload);
      // Limit preview length to keep metadata lightweight.
      return json.length > 500 ? `${json.slice(0, 500)}…` : json;
    } catch {
      return String(payload);
    }
  }

  private extractPayloadKeys(payloadObject: MasMetadataBag): string[] {
    try {
      return Object.keys(payloadObject).slice(0, 10);
    } catch {
      return [];
    }
  }

  private buildPlanMetadata(
    session: MasSessionContext,
  ): MasMetadataBag {
    const metadata: MasMetadataBag = {
      generatedBy: 'TaskDecomposerV1',
      sessionMasSessionId: session.masSessionId,
      sessionCorrelationId: session.correlationId,
    };

    if (typeof session.tenantId !== 'undefined') {
      metadata.sessionTenantId = session.tenantId;
    }

    if (typeof session.userId !== 'undefined') {
      metadata.sessionUserId = session.userId;
    }

    if (typeof session.masTraceId !== 'undefined') {
      metadata.sessionMasTraceId = session.masTraceId;
    }

    return metadata;
  }
}