/**
 * ArticleFinderResearchService — IResearchService facade over IArticleFinder.
 *
 * Deep research (o3-style decompose → search → synthesize) calls this port.
 * Ranking is positional: the finder returns topic order, so the first hit
 * scores 1 and later hits fall off. minRelevance drops the tail.
 */
import type { CorrelationId } from '../../core/types/branded';
import type { IArticleFinder } from '../../domain/research';
import { ResearchTopic } from '../../domain/research';
import type { IResearchService, SearchOptions } from '../../domain/research/research-service.interface';
import type { ResearchSource } from '../../domain/research/deep-research.interface';

const TOPIC_MIN_LENGTH = 3;
const MAX_LIMIT = 50;

export class ArticleFinderResearchService implements IResearchService {
  constructor(private readonly finder: IArticleFinder) {}

  async search(
    query: string,
    options: SearchOptions,
    _correlationId: CorrelationId,
  ): Promise<readonly ResearchSource[]> {
    const topic = query.trim();
    const limit = Number.isFinite(options.maxResults)
      ? Math.min(MAX_LIMIT, Math.floor(options.maxResults))
      : 0;
    if (topic.length < TOPIC_MIN_LENGTH || limit < 1) {
      return [];
    }

    const articles = await this.finder.findByTopic(ResearchTopic.fromString(topic), limit);
    const minRelevance = options.minRelevance ?? 0;
    const sources: ResearchSource[] = [];

    for (let index = 0; index < articles.length && sources.length < limit; index++) {
      const article = articles[index];
      const relevanceScore = articles.length <= 1 ? 1 : 1 - index / articles.length;
      if (relevanceScore < minRelevance) {
        continue;
      }
      sources.push({
        url: article.source,
        title: article.title,
        snippet: article.abstract,
        relevanceScore,
      });
    }

    return sources;
  }
}
