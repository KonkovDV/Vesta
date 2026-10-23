import { ITrendAnalyzer, ArticleSummary, ResearchTrends } from '../../domain/research';
import { ILLMAdapterFactory } from '../../ai/llm/interfaces/llm-adapter-factory.interface';
import { RateLimiter, type IRateLimiter } from '../../core/utils/RateLimiter';

export class LLMTrendAnalyzer implements ITrendAnalyzer {
  private readonly rateLimiter: IRateLimiter;

  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    rateLimiter?: IRateLimiter,
  ) {
    this.rateLimiter = rateLimiter ?? new RateLimiter(10, 2);
  }

  async analyze(summaries: ArticleSummary[]): Promise<ResearchTrends> {
    if (summaries.length === 0) {
      throw new Error('Cannot analyze trends from empty summaries');
    }

    await this.rateLimiter.acquire(1);

    const llm = this.llmFactory.createAdapter('gpt-4');

    const summariesText = summaries
      .map((summary, index) => `Article ${index + 1}: ${summary.content}`)
      .join('\n\n');

    const prompt = [
      'Analyze the provided research summaries and identify key trends, patterns, and emerging themes. Provide a concise summary of the main trends with a confidence score between 0 and 1.',
      summariesText,
    ].join('\n\n');

    const response = await llm.generateText(prompt, {
      temperature: 0.4,
      maxTokens: 500,
    });

    // Extract confidence from response or default to 0.8
    const content = response.text;
    const confidenceMatch = content.match(/confidence:?\s*([0-9.]+)/i);
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.8;

    return ResearchTrends.create(content, Math.min(Math.max(confidence, 0), 1));
  }
}
