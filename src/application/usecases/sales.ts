import { DomainEvent } from '../../domain/events/event-store.interface';
import { EventStoreService } from '../services/EventStoreService';
import { EventBusService } from '../services/EventBusService';
import { getCorrelationId, UseCaseResult, publishAggregateEvents } from './shared/use-case.utils';

export type { UseCaseResult };

/**
 * 1) LeadScoringUseCase - AI-powered lead scoring and prioritization
 */
export interface LeadScoringInput {
  leadId: string;
  companyData: Record<string, unknown>;
  interactionHistory: Array<{ type: string; timestamp: string; data: Record<string, unknown> }>;
}
export interface LeadScoringOutput {
  leadId: string;
  score: number;
  priority: 'high' | 'medium' | 'low';
  insights: string[];
}
export class LeadScoringUseCase {
  constructor(
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBusService
  ) {}

  async execute(input: LeadScoringInput): Promise<UseCaseResult<LeadScoringOutput>> {
    try {
      if (!input.leadId || input.leadId.trim().length === 0) {
        return { ok: false, error: { code: 'VALIDATION', message: 'leadId is required' } };
      }

      const corr = getCorrelationId();

      // Deterministic scoring based on interaction history and company data
      const interactionScore = Math.min(input.interactionHistory.length * 10, 40);
      const companyFieldScore = Math.min(Object.keys(input.companyData).length * 5, 30);
      const recencyScore = this.calculateRecencyScore(input.interactionHistory);
      const score = Math.min(interactionScore + companyFieldScore + recencyScore, 100);

      const priority = score > 70 ? 'high' : score > 40 ? 'medium' : 'low';
      const insights = this.deriveInsights(input, score);

      const event: DomainEvent = {
        eventId: `lead-scored-${input.leadId}-${Date.now()}`,
        type: 'lead.scored',
        aggregateId: input.leadId,
        aggregateVersion: 1,
        timestamp: new Date(),
        payload: { score, priority, insights },
        correlationId: corr || ''
      };

      await publishAggregateEvents([event], this.eventStore);

      return { ok: true, data: { leadId: input.leadId, score, priority, insights } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Lead scoring failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }

  private calculateRecencyScore(history: LeadScoringInput['interactionHistory']): number {
    if (history.length === 0) return 0;
    const now = Date.now();
    const mostRecent = history.reduce((latest, item) => {
      const ts = new Date(item.timestamp).getTime();
      return ts > latest ? ts : latest;
    }, 0);
    const daysSince = (now - mostRecent) / (1000 * 60 * 60 * 24);
    if (daysSince <= 7) return 30;
    if (daysSince <= 30) return 20;
    if (daysSince <= 90) return 10;
    return 0;
  }

  private deriveInsights(input: LeadScoringInput, score: number): string[] {
    const insights: string[] = [];
    if (input.interactionHistory.length >= 5) insights.push('High engagement frequency');
    if (input.interactionHistory.some(i => i.type === 'demo')) insights.push('Demo requested');
    if (input.interactionHistory.some(i => i.type === 'pricing')) insights.push('Pricing page visited');
    if (score > 70) insights.push('Strong buy signal');
    if (insights.length === 0) insights.push('Needs nurturing');
    return insights;
  }
}

/**
 * 2) SalesForecastingUseCase - Predictive sales forecasting
 */
export interface SalesForecastingInput {
  period: string;
  historicalData: Array<{ month: string; revenue: number; deals: number }>;
}
export interface SalesForecastingOutput {
  forecast: Array<{ month: string; predictedRevenue: number; confidence: number }>;
  insights: string[];
}
export class SalesForecastingUseCase {
  constructor(
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBusService
  ) {}

  async execute(input: SalesForecastingInput): Promise<UseCaseResult<SalesForecastingOutput>> {
    try {
      if (!input.period || input.period.trim().length === 0) {
        return { ok: false, error: { code: 'VALIDATION', message: 'period is required' } };
      }
      if (!input.historicalData || input.historicalData.length === 0) {
        return { ok: false, error: { code: 'VALIDATION', message: 'historicalData is required' } };
      }

      const corr = getCorrelationId();

      // Weighted moving average forecasting with trend detection
      const revenues = input.historicalData.map(d => d.revenue);
      const avgRevenue = revenues.reduce((sum, r) => sum + r, 0) / revenues.length;
      const trend = revenues.length >= 2
        ? (revenues[revenues.length - 1] - revenues[0]) / revenues.length
        : 0;
      const trendDirection = trend > 0 ? 1.0 : trend < 0 ? -1.0 : 0;

      const forecast = input.historicalData.map((item, index) => {
        const projected = avgRevenue + trend * (index + 1);
        const confidence = Math.max(0.5, 0.95 - (index * 0.05));
        return {
          month: item.month,
          predictedRevenue: Math.round(Math.max(0, projected) * 100) / 100,
          confidence: Math.round(confidence * 100) / 100,
        };
      });

      const insights: string[] = [];
      if (trendDirection > 0) insights.push('Growing revenue trend detected');
      else if (trendDirection < 0) insights.push('Declining revenue trend — review strategy');
      else insights.push('Flat revenue trend');

      const variance = revenues.reduce((sum, r) => sum + Math.pow(r - avgRevenue, 2), 0) / revenues.length;
      if (variance > avgRevenue * avgRevenue * 0.1) insights.push('High revenue volatility observed');

      const event: DomainEvent = {
        eventId: `forecast-${input.period}-${Date.now()}`,
        type: 'sales.forecast.generated',
        aggregateId: input.period,
        aggregateVersion: 1,
        timestamp: new Date(),
        payload: { forecast, insights },
        correlationId: corr || ''
      };

      await publishAggregateEvents([event], this.eventStore);

      return { ok: true, data: { forecast, insights } };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Sales forecasting failed';
      return { ok: false, error: { code: 'UNEXPECTED', message: errorMessage } };
    }
  }
}