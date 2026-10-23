import { IArticleSummarizer, Article, ArticleSummary } from '../../domain/research';
import { ILLMAdapterFactory } from '../../ai/llm/interfaces/llm-adapter-factory.interface';
import { RateLimiter, type IRateLimiter } from '../../core/utils/RateLimiter';

export class LLMArticleSummarizer implements IArticleSummarizer {
  private readonly rateLimiter: IRateLimiter;

  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    rateLimiter?: IRateLimiter,
  ) {
    this.rateLimiter = rateLimiter ?? new RateLimiter(10, 2);
  }

  async summarize(article: Article): Promise<ArticleSummary> {
    await this.rateLimiter.acquire(1);

    const llm = this.llmFactory.createAdapter('gpt-4');

    const prompt = [
      'Summarize this academic paper concisely in 2-3 sentences, focusing on key findings and methodology.',
      `Title: ${article.title}\n\nAbstract: ${article.abstract}`,
    ].join('\n\n');

    const response = await llm.generateText(prompt, {
      temperature: 0.3,
      maxTokens: 300,
    });

    return ArticleSummary.create(article.id, response.text);
  }
}
