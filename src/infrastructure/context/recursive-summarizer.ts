/**
 * Recursive Summarizer
 * Recursively chunks and summarizes conversation history to fit within context limits.
 * Layer: Infrastructure
 */
import { injectable, inject } from 'inversify';
import { IAIClient } from '../../domain/ai/IAIClient';
import { ITokenizer } from '../../domain/ai/tokenizer.interface';

export interface ISummarizer {
  summarize(content: string | string[]): Promise<string>;
}

@injectable()
export class RecursiveSummarizer implements ISummarizer {
  private readonly CHUNK_SIZE = 4000; // Tokens per chunk for summarization
  private readonly SUMMARY_RATIO = 0.2; // Target compression

  constructor(
    @inject('IAIClient') private aiClient: IAIClient,
    @inject('ITokenizer') private tokenizer: ITokenizer
  ) {}

  async summarize(content: string | string[]): Promise<string> {
    const text = Array.isArray(content) ? content.join('\n\n') : content;
    const tokens = this.tokenizer.countTokens(text);

    if (tokens <= this.CHUNK_SIZE) {
      return this.generateSummary(text);
    }

    // Recursive Strategy
    // Split into chunks
    const chunks = this.splitIntoChunks(text, this.CHUNK_SIZE);
    
    // Summarize each chunk
    const summaryResults = await Promise.allSettled(chunks.map(chunk => this.generateSummary(chunk)));
    const summaryFailure = summaryResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (summaryFailure) {
      throw summaryFailure.reason;
    }
    const summaries = summaryResults
      .filter(
        (result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled',
      )
      .map((result) => result.value);
    
    // Recursively summarize the combined summaries
    return this.summarize(summaries.join('\n\n'));
  }

  private splitIntoChunks(text: string, maxTokens: number): string[] {
    // Naive split by length approximation or use tokenizer decoding
    // For strict correctness, we should use tokenizer.encode() -> slice -> tokenizer.decode()
    // But GptTokenizerAdapter.encode returns number[].
    
    const tokens = this.tokenizer.encode(text);
    const chunks: string[] = [];
    
    for (let i = 0; i < tokens.length; i += maxTokens) {
      const chunkTokens = tokens.slice(i, i + maxTokens);
      chunks.push(this.tokenizer.decode(chunkTokens));
    }
    
    return chunks;
  }

  private async generateSummary(text: string): Promise<string> {
    try {
      const result = await this.aiClient.generateText(
        `Summarize the following conversation/text efficiently, preserving key facts, decisions, and context for future reference:\n\n${text}`,
        {
          model: 'gpt-3.5-turbo', // Cost-effective summarizer
          temperature: 0.3,
          maxTokens: 1000
        }
      );
      return result.text;
    } catch (error) {
      console.error('[RecursiveSummarizer] Failed to summarize', error);
      return text.substring(0, 100) + '... [Summarization Failed]';
    }
  }
}
