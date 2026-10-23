import { z } from 'zod';
import { DomainEvent } from '../../core/domain/AggregateRoot';
import { CorrelationIdProvider } from '../../core/correlation/correlation';
import { ResearchReportId } from './ResearchIdentifiers';
import { IdGenerator } from '../../core/utils/IdGenerator';

// Base event schema for research domain
const ResearchDomainEventSchema = z.object({
  eventId: z.string(),
  aggregateId: z.string(),
  aggregateVersion: z.number(),
  correlationId: z.string(),
  causationId: z.string().optional(),
  timestamp: z.date(),
});

// ResearchReportCreated event
export const ResearchReportCreatedEventSchema = ResearchDomainEventSchema.extend({
  type: z.literal('ResearchReportCreated'),
  payload: z.object({
    topic: z.string(),
    requestedBy: z.string(),
    createdAt: z.string(),
  }),
});

export type ResearchReportCreatedEvent = z.infer<typeof ResearchReportCreatedEventSchema>;

// ArticleAdded event
export const ArticleAddedEventSchema = ResearchDomainEventSchema.extend({
  type: z.literal('ArticleAdded'),
  payload: z.object({
    articleId: z.string(),
    title: z.string(),
    abstract: z.string(),
    source: z.string(),
    relevanceScore: z.number(),
  }),
});

export type ArticleAddedEvent = z.infer<typeof ArticleAddedEventSchema>;

// ArticleSummarized event
export const ArticleSummarizedEventSchema = ResearchDomainEventSchema.extend({
  type: z.literal('ArticleSummarized'),
  payload: z.object({
    articleId: z.string(),
    summary: z.string(),
    summaryLength: z.number(),
  }),
});

export type ArticleSummarizedEvent = z.infer<typeof ArticleSummarizedEventSchema>;

// TrendsAnalyzed event
export const TrendsAnalyzedEventSchema = ResearchDomainEventSchema.extend({
  type: z.literal('TrendsAnalyzed'),
  payload: z.object({
    summary: z.string(),
    confidence: z.number(),
  }),
});

export type TrendsAnalyzedEvent = z.infer<typeof TrendsAnalyzedEventSchema>;

// ResearchReportFinalized event
export const ResearchReportFinalizedEventSchema = ResearchDomainEventSchema.extend({
  type: z.literal('ResearchReportFinalized'),
  payload: z.object({
    completedAt: z.string(),
    articlesCount: z.number(),
    summariesCount: z.number(),
  }),
});

export type ResearchReportFinalizedEvent = z.infer<typeof ResearchReportFinalizedEventSchema>;

// Union type for all research domain events
export type ResearchDomainEvent =
  | ResearchReportCreatedEvent
  | ArticleAddedEvent
  | ArticleSummarizedEvent
  | TrendsAnalyzedEvent
  | ResearchReportFinalizedEvent;

// Factory functions for creating events
export function createResearchReportCreatedEvent(
  aggregateId: ResearchReportId,
  aggregateVersion: number,
  payload: { topic: string; requestedBy: string; createdAt: string },
  correlationId?: string,
): ResearchReportCreatedEvent {
  const aggregateIdValue = aggregateId.toString();
  const corr = CorrelationIdProvider.normalize(correlationId);
  return {
    eventId: generateResearchEventId(aggregateIdValue),
    type: 'ResearchReportCreated',
    aggregateId: aggregateIdValue,
    aggregateVersion,
    correlationId: corr,
    timestamp: new Date(),
    payload,
  };
}

export function createArticleAddedEvent(
  aggregateId: ResearchReportId,
  aggregateVersion: number,
  payload: { articleId: string; title: string; abstract: string; source: string; relevanceScore: number },
  correlationId?: string,
): ArticleAddedEvent {
  const aggregateIdValue = aggregateId.toString();
  const corr = CorrelationIdProvider.normalize(correlationId);
  return {
    eventId: generateResearchEventId(aggregateIdValue),
    type: 'ArticleAdded',
    aggregateId: aggregateIdValue,
    aggregateVersion,
    correlationId: corr,
    timestamp: new Date(),
    payload,
  };
}

export function createArticleSummarizedEvent(
  aggregateId: ResearchReportId,
  aggregateVersion: number,
  payload: { articleId: string; summary: string; summaryLength: number },
  correlationId?: string,
): ArticleSummarizedEvent {
  const aggregateIdValue = aggregateId.toString();
  const corr = CorrelationIdProvider.normalize(correlationId);
  return {
    eventId: generateResearchEventId(aggregateIdValue),
    type: 'ArticleSummarized',
    aggregateId: aggregateIdValue,
    aggregateVersion,
    correlationId: corr,
    timestamp: new Date(),
    payload,
  };
}

export function createTrendsAnalyzedEvent(
  aggregateId: ResearchReportId,
  aggregateVersion: number,
  payload: { summary: string; confidence: number },
  correlationId?: string,
): TrendsAnalyzedEvent {
  const aggregateIdValue = aggregateId.toString();
  const corr = CorrelationIdProvider.normalize(correlationId);
  return {
    eventId: generateResearchEventId(aggregateIdValue),
    type: 'TrendsAnalyzed',
    aggregateId: aggregateIdValue,
    aggregateVersion,
    correlationId: corr,
    timestamp: new Date(),
    payload,
  };
}

export function createResearchReportFinalizedEvent(
  aggregateId: ResearchReportId,
  aggregateVersion: number,
  payload: { completedAt: string; articlesCount: number; summariesCount: number },
  correlationId?: string,
): ResearchReportFinalizedEvent {
  const aggregateIdValue = aggregateId.toString();
  const corr = CorrelationIdProvider.normalize(correlationId);
  return {
    eventId: generateResearchEventId(aggregateIdValue),
    type: 'ResearchReportFinalized',
    aggregateId: aggregateIdValue,
    aggregateVersion,
    correlationId: corr,
    timestamp: new Date(),
    payload,
  };
}

// Validation function
export function validateResearchDomainEvent(event: unknown): ResearchDomainEvent {
  const schemas = [
    ResearchReportCreatedEventSchema,
    ArticleAddedEventSchema,
    ArticleSummarizedEventSchema,
    TrendsAnalyzedEventSchema,
    ResearchReportFinalizedEventSchema,
  ];

  for (const schema of schemas) {
    const result = schema.safeParse(event);
    if (result.success) {
      return result.data;
    }
  }

  throw new Error(`Invalid research domain event: ${JSON.stringify(event)}`);
}

// Type guard functions
export function isResearchReportCreatedEvent(event: DomainEvent): event is ResearchReportCreatedEvent {
  return (event as { type?: string }).type === 'ResearchReportCreated';
}

export function isArticleAddedEvent(event: DomainEvent): event is ArticleAddedEvent {
  return (event as { type?: string }).type === 'ArticleAdded';
}

export function isArticleSummarizedEvent(event: DomainEvent): event is ArticleSummarizedEvent {
  return (event as { type?: string }).type === 'ArticleSummarized';
}

export function isTrendsAnalyzedEvent(event: DomainEvent): event is TrendsAnalyzedEvent {
  return (event as { type?: string }).type === 'TrendsAnalyzed';
}

export function isResearchReportFinalizedEvent(event: DomainEvent): event is ResearchReportFinalizedEvent {
  return (event as { type?: string }).type === 'ResearchReportFinalized';
}

// Local helper for eventId generation in research domain
function generateResearchEventId(aggregateId: string): string {
  const timestamp = Date.now();
  const random = IdGenerator.generateRandomString(9);
  return `evt_${aggregateId}_${timestamp}_${random}`;
}