import { DecoratorComposer, MetricsDecorator } from '../../../core/decorators/IDecorator';
import type { IUnifiedPluginRegistry } from '../../plugins/unified-plugin-registry';
import type { IRequestContext } from '../../context/request-context';
import { ISessionMemoryManager } from '../../../domain/memory/ISessionMemoryManager';
import {
  ResearchReport,
  ResearchReportId,
  ResearchTopic,
  ResearcherId,
  ResearchDepth,
  IArticleFinder,
  IArticleSummarizer,
  ITrendAnalyzer,
} from '../../../domain/research';
import type { IResearchReportRepository } from '../../../domain/research/IResearchReportRepository';
import { DomainError, InfrastructureError } from '../../../domain/errors/DomainError';

type ConductLiteratureReviewArgs = [ResearchTopic, ResearcherId, ResearchDepth, IRequestContext];

export class ResearchAssistanceUseCase {
  private readonly decoratorComposer: DecoratorComposer<ConductLiteratureReviewArgs, ResearchReportId>;

  constructor(
    private reportRepository: IResearchReportRepository,
    private articleFinder: IArticleFinder,
    private articleSummarizer: IArticleSummarizer,
    private trendAnalyzer: ITrendAnalyzer,
    private sessionManager: ISessionMemoryManager,
    private pluginRegistry: IUnifiedPluginRegistry,
  ) {
    this.decoratorComposer = new DecoratorComposer<ConductLiteratureReviewArgs, ResearchReportId>();
    this.decoratorComposer.addDecorator(
      new MetricsDecorator<ConductLiteratureReviewArgs, ResearchReportId>(),
    );
  }

  async conductLiteratureReview(
    topic: ResearchTopic,
    researcherId: ResearcherId,
    depth: ResearchDepth,
    context: IRequestContext,
  ): Promise<ResearchReportId> {
    const result = await this.decoratorComposer.execute(
      this._conductLiteratureReviewInternal.bind(this),
      [topic, researcherId, depth, context],
      'conductLiteratureReview',
    );

    if (!result.success) {
      throw result.error;
    }

    if (!result.result) {
      throw new Error('Decorator pipeline returned success without result');
    }

    return result.result;
  }
 
  private async _conductLiteratureReviewInternal(
    topic: ResearchTopic,
    researcherId: ResearcherId,
    depth: ResearchDepth,
    context: IRequestContext,
  ): Promise<ResearchReportId> {
    try {
      // Find articles using domain service with validated topic and depth
      const articles = await this.articleFinder.findByTopic(topic, depth.value);
 
      // Create domain aggregate
      const report = ResearchReport.create(topic, researcherId);
 
      // Add articles to aggregate (validates relevance and invariants)
      report.addArticles(articles);
 
      // Generate summaries using domain service
      await report.generateSummaries(this.articleSummarizer);
 
      // Analyze trends using domain service
      await report.analyzeTrends(this.trendAnalyzer);
 
      // Finalize the report
      report.finalize();
 
      // Save aggregate through repository
      await this.reportRepository.save(report);
 
      return report.id;
 
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        throw error;
      }

      const correlationId = context.getCorrelationId();
 
      if (error instanceof Error) {
        throw new InfrastructureError(
          'Literature review failed',
          {
            correlationId,
            metadata: {
              topic: topic.value,
              researcherId: researcherId.toValue(),
              depth: depth.value,
            },
            cause: error,
          },
        );
      }
 
      throw new InfrastructureError(
        'Literature review failed: non-error thrown',
        {
          correlationId,
          metadata: {
            topic: topic.value,
            researcherId: researcherId.toValue(),
            depth: depth.value,
            error,
          },
        },
      );
    }
  }
}
