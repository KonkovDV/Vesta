import { DomainEvent } from '../../domain/events/event-store.interface';
import { EventStoreService } from '../services/EventStoreService';
import { EventBusService } from '../services/EventBusService';
import { getCorrelationId, UseCaseResult, publishAggregateEvents } from './shared/use-case.utils';

export type { UseCaseResult };

/**
 * 1) TalentAcquisitionUseCase - AI-powered recruitment and candidate matching
 */
export interface TalentAcquisitionInput {
  jobId: string;
  candidateProfile: Record<string, unknown>;
  jobRequirements: Record<string, unknown>;
}
export interface TalentAcquisitionOutput {
  candidateId: string;
  matchScore: number;
  recommendations: string[];
}
export class TalentAcquisitionUseCase {
  constructor(
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBusService
  ) {}

  async execute(input: TalentAcquisitionInput): Promise<UseCaseResult<TalentAcquisitionOutput>> {
    try {
      if (!input.jobId || input.jobId.trim().length === 0) {
        return { ok: false, error: { code: 'VALIDATION', message: 'jobId is required' } };
      }

      const corr = getCorrelationId();

      // Deterministic matching: compare requirement keys present in candidate profile
      const reqKeys = Object.keys(input.jobRequirements);
      const profileKeys = new Set(Object.keys(input.candidateProfile));
      const matchedKeys = reqKeys.filter(k => profileKeys.has(k));
      const matchScore = reqKeys.length > 0
        ? Math.round((matchedKeys.length / reqKeys.length) * 100)
        : 0;

      const recommendations: string[] = [];
      if (matchScore >= 80) recommendations.push('Strong technical fit');
      if (matchScore >= 60) recommendations.push('Good cultural alignment potential');
      const missingKeys = reqKeys.filter(k => !profileKeys.has(k));
      if (missingKeys.length > 0) {
        recommendations.push(`Missing requirements: ${missingKeys.slice(0, 3).join(', ')}`);
      }
      if (recommendations.length === 0) recommendations.push('Further evaluation needed');

      const candidateId = `candidate-${input.jobId}-${matchedKeys.length}`;

      const event: DomainEvent = {
        eventId: `candidate-matched-${input.jobId}-${Date.now()}`,
        type: 'candidate.matched',
        aggregateId: input.jobId,
        aggregateVersion: 1,
        timestamp: new Date(),
        payload: { matchScore, recommendations, candidateId },
        correlationId: corr || ''
      };

      await publishAggregateEvents([event], this.eventStore);

      return { ok: true, data: { candidateId, matchScore, recommendations } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Talent acquisition failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}

/**
 * 2) EmployeeEngagementUseCase - Predictive employee engagement analysis
 */
export interface EmployeeEngagementInput {
  employeeId: string;
  surveyData: Record<string, unknown>;
  performanceMetrics: Array<{ metric: string; value: number; date: string }>;
}
export interface EmployeeEngagementOutput {
  engagementScore: number;
  riskLevel: 'low' | 'medium' | 'high';
  actionItems: string[];
}
export class EmployeeEngagementUseCase {
  constructor(
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBusService
  ) {}

  async execute(input: EmployeeEngagementInput): Promise<UseCaseResult<EmployeeEngagementOutput>> {
    try {
      if (!input.employeeId || input.employeeId.trim().length === 0) {
        return { ok: false, error: { code: 'VALIDATION', message: 'employeeId is required' } };
      }

      const corr = getCorrelationId();

      // Deterministic engagement scoring from survey + performance data
      const surveyFields = Object.keys(input.surveyData);
      const surveyScore = Math.min(surveyFields.length * 10, 50);

      const metrics = input.performanceMetrics;
      const avgPerformance = metrics.length > 0
        ? metrics.reduce((sum, m) => sum + m.value, 0) / metrics.length
        : 0;
      const performanceScore = Math.min(Math.round(avgPerformance / 2), 50);

      const engagementScore = Math.min(surveyScore + performanceScore, 100);
      const riskLevel = engagementScore < 30 ? 'high' : engagementScore < 60 ? 'medium' : 'low';

      const actionItems: string[] = [];
      if (riskLevel === 'high') {
        actionItems.push('Schedule urgent 1:1 meeting');
        actionItems.push('Assess workload and burnout indicators');
      }
      if (riskLevel === 'medium') {
        actionItems.push('Provide development opportunities');
        actionItems.push('Check on work-life balance');
      }
      if (metrics.some(m => m.value < 30)) {
        actionItems.push('Review performance support plan');
      }
      if (actionItems.length === 0) actionItems.push('Continue current engagement strategy');

      const event: DomainEvent = {
        eventId: `engagement-analyzed-${input.employeeId}-${Date.now()}`,
        type: 'employee.engagement.analyzed',
        aggregateId: input.employeeId,
        aggregateVersion: 1,
        timestamp: new Date(),
        payload: { engagementScore, riskLevel, actionItems },
        correlationId: corr || ''
      };

      await publishAggregateEvents([event], this.eventStore);

      return { ok: true, data: { engagementScore, riskLevel, actionItems } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Employee engagement analysis failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}