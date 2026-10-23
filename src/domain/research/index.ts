// Domain entities and value objects
export { ResearchReportId, ResearcherId } from './ResearchIdentifiers';
export { ResearchTopic, ResearchDepth, Article, ArticleSummary, ResearchTrends } from './ResearchReport';
export type { ResearchReportStatus } from './ResearchReport';

// Aggregate
export { ResearchReport } from './ResearchReport';
export type { ResearchReportProps } from './ResearchReport';

// Domain services interfaces
export type { IArticleFinder, IArticleSummarizer, ITrendAnalyzer } from './ResearchReport';

// Domain events
export type {
  ResearchDomainEvent,
  ResearchReportCreatedEvent,
  ArticleAddedEvent,
  ArticleSummarizedEvent,
  TrendsAnalyzedEvent,
  ResearchReportFinalizedEvent,
} from './events';

// Event factories
export {
  createResearchReportCreatedEvent,
  createArticleAddedEvent,
  createArticleSummarizedEvent,
  createTrendsAnalyzedEvent,
  createResearchReportFinalizedEvent,
} from './events';

// Event type guards
export {
  isResearchReportCreatedEvent,
  isArticleAddedEvent,
  isArticleSummarizedEvent,
  isTrendsAnalyzedEvent,
  isResearchReportFinalizedEvent,
} from './events';

// Event validation
export { validateResearchDomainEvent } from './events';