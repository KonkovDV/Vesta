/**
 * MasGeneratePlanUseCase — прикладной MAS use-case для генерации плана шагов.
 *
 * Layer: Application (BFF/use-case слой поверх MAS Runtime Core).
 *
 * MAS-NEXT-STEP5:
 * - вход: { goal, maxSteps? } + IRequestContext;
 * - выполнение: MasterAgentV1 (IMasterAgent) по MAS Request;
 * - выход: MasPlanDto с плоским списком шагов.
 */

import type { IRequestContext } from '../../context/request-context';
import type {
  MasRequest,
  MasResponse,
  MasTask,
  MasTaskPlan,
} from '../../agents/types/mas-types';
import type { IMasterAgent } from '../../agents/core/master-agent';

/**
 * DTO одного шага плана на уровне Application.
 */
export interface MasPlanStepDto {
  id: string;
  description: string;
}

/**
 * DTO плана, возвращаемого BFF-эндпоинтом.
 *
 * Минимальный контракт:
 * - steps[] — плоский список шагов;
 * - summary/diagnostics — опциональны.
 */
export interface MasPlanDto {
  steps: MasPlanStepDto[];
  summary?: string;
  diagnostics?: Record<string, unknown>;
}

/**
 * Входной контракт use-case.
 */
export interface MasGeneratePlanInput {
  goal: string;
  maxSteps?: number;
}

/**
 * MAS-сценарий и use-case labels для метрик/typed-событий.
 * Используются только на уровне MasRequest, без изменений core-типов.
 */
export const MAS_GENERATE_PLAN_SCENARIO = 'mas_generate_plan_v1';
export const MAS_GENERATE_PLAN_USE_CASE = 'mas_generate_plan_http_bff';

function isTaskPlanPayload(value: unknown): value is { plan: MasTaskPlan } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const plan = record.plan;
  return typeof plan === 'object' && plan !== null && Array.isArray((plan as { tasks?: unknown }).tasks);
}

function isTaskArrayPayload(value: unknown): value is { tasks: MasTask[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { tasks?: unknown }).tasks);
}

/**
 * Application-level use-case, инкапсулирующий вызов MasterAgent.
 *
 * Ответственный только за:
 * - нормализацию входа (goal/maxSteps);
 * - формирование MasRequest;
 * - вызов IMasterAgent с IRequestContext;
 * - проекцию MasResponse → MasPlanDto.
 *
 * Вся observability (метрики/typed-события) остаётся внутри MAS Runtime Core.
 */
export class MasGeneratePlanUseCase {
  constructor(private readonly masterAgent: IMasterAgent) {}

  async execute(
    input: MasGeneratePlanInput,
    ctx: IRequestContext,
  ): Promise<MasPlanDto> {
    const trimmedGoal = (input.goal ?? '').trim();
    if (!trimmedGoal) {
      throw new Error(
        'MasGeneratePlanUseCase: "goal" must be a non-empty string',
      );
    }

    const masRequest: MasRequest = {
      scenario: MAS_GENERATE_PLAN_SCENARIO,
      useCase: MAS_GENERATE_PLAN_USE_CASE,
      payload: {
        goal: trimmedGoal,
        // maxSteps пока не интерпретируется MAS Runtime, но передаётся в payload
        // как часть прикладного контракта.
        maxSteps:
          typeof input.maxSteps === 'number' && Number.isFinite(input.maxSteps)
            ? input.maxSteps
            : undefined,
      },
      metadata: {
        source: 'bff_mas_generate_plan_v1',
      },
    };

    const masResponse = await this.masterAgent.executeMultiAgentTask(
      masRequest,
      ctx,
    );

    const plan = this.extractPlan(masResponse);
    const steps: MasPlanStepDto[] =
      plan?.tasks?.map(task => this.mapTaskToStep(task)) ?? [];

    const summary =
      typeof input.maxSteps === 'number'
        ? `Plan for goal "${trimmedGoal}" with up to ${input.maxSteps} steps`
        : `Plan for goal "${trimmedGoal}"`;

    const diagnostics =
      masResponse.diagnostics &&
      typeof masResponse.diagnostics === 'object'
        ? (masResponse.diagnostics as Record<string, unknown>)
        : undefined;

    return {
      steps,
      summary,
      diagnostics,
    };
  }

  private extractPlan(masResponse: MasResponse): MasTaskPlan | undefined {
    const rawResult = masResponse.result;

    if (isTaskPlanPayload(rawResult)) {
      return rawResult.plan;
    }

    if (isTaskArrayPayload(rawResult)) {
      const tasks = rawResult.tasks;
      return {
        tasks,
        entryTaskIds: tasks.map(task => task.id),
        metadata: undefined,
      };
    }

    return undefined;
  }

  private mapTaskToStep(task: MasTask): MasPlanStepDto {
    const id = String(task.id);
    const description =
      typeof task.description === 'string' && task.description.trim().length > 0
        ? task.description
        : id;

    return {
      id,
      description,
    };
  }
}