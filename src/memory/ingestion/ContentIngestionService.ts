/**
 * Content Ingestion Service — handles PDF, Image, Text ingestion.
 *
 * Extraction stays here. Storage goes through IngestedFactRecorder:
 * one content event, then each fact through the memory-fact gate.
 *
 * Layer: Memory/Ingestion
 */

import { createHash } from 'node:crypto';
import { inject, injectable } from 'inversify';
import { v4 as uuidv4 } from 'uuid';
import type {
  IContentIngestionService,
  IngestPDFInput,
  IngestImageInput,
  IngestTextInput,
  IngestURLInput,
  IngestContentResult,
  IngestContentInput,
  IngestedFact,
  IngestedFactRecorder,
  IngestRejection,
  IngestibleContentType,
} from './types';
import { chunkText, mergeChunkFacts } from './TextChunker';

function assertPublicHttpUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Only http and https URLs can be ingested');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be ingested');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateLiteral = host === 'localhost'
    || host.endsWith('.localhost')
    || host === '0.0.0.0'
    || host === '::1'
    || host === '169.254.169.254'
    || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host);
  if (privateLiteral) {
    throw new Error('URL host is not allowed');
  }
}

/**
 * PDF Parser interface (optional dependency).
 */
interface IPDFParser {
  parse(buffer: Buffer): Promise<{ text: string; numpages: number }>;
}

/**
 * HTTP Client for URL fetching.
 */
interface IHttpClient {
  get?(url: string): Promise<{ data: string | Buffer; status: number }>;
  request?(options: { method: string; url: string; responseType?: 'buffer' }): Promise<{
    body: string | Buffer;
    statusCode: number;
    headers?: Record<string, string>;
  }>;
}

/**
 * LLM Client for fact extraction.
 */
interface ILLMClient {
  chat?(messages: Array<{ role: string; content: string | object }>): Promise<string>;
  generateText?(prompt: string): Promise<{ text: string }>;
  generateMultimodalChat?(messages: unknown): Promise<{ text: string }>;
}

@injectable()
export class ContentIngestionService implements IContentIngestionService {
  private readonly pdfParser?: IPDFParser;
  private readonly httpClient?: IHttpClient;
  private readonly llmClient: ILLMClient;

  constructor(
    @inject('ILLMClient') llmClient: ILLMClient,
    @inject('IPDFParser') pdfParser?: IPDFParser,
    @inject('IHttpClient') httpClient?: IHttpClient,
    private readonly validateRemoteUrl?: (url: string) => Promise<void>,
    private readonly recorder?: IngestedFactRecorder,
  ) {
    this.llmClient = llmClient;
    this.pdfParser = pdfParser;
    this.httpClient = httpClient;
  }

  async ingestPDF(input: IngestPDFInput): Promise<IngestContentResult> {
    const startTime = Date.now();
    const warnings: string[] = [];

    if (!this.pdfParser) {
      throw new Error('PDF parser not available. Install pdf-parse package.');
    }

    let pdfBuffer: Buffer;
    
    if (input.isBase64) {
      pdfBuffer = Buffer.from(input.source, 'base64');
    } else {
      // Fetch PDF from URL
      if (!this.httpClient) {
        throw new Error('HTTP client not available for URL fetch');
      }
      const response = await this.fetchUrl(input.source, 'buffer');
      pdfBuffer = Buffer.isBuffer(response) ? response : Buffer.from(response, 'binary');
    }

    const pdfResult = await this.pdfParser.parse(pdfBuffer);
    const text = pdfResult.text;

    if (!text || text.trim().length === 0) {
      warnings.push('PDF appears to be empty or image-only');
      return {
        chunksProcessed: 0,
        facts: [],
        processingTimeMs: Date.now() - startTime,
        warnings,
      };
    }

    // Chunk the text
    const chunks = chunkText(text);
    const factsByChunk: IngestedFact[][] = [];

    for (const chunk of chunks) {
      const facts = await this.extractFactsFromText(
        chunk.text,
        input.extractionPrompt,
        `page_estimate:${Math.floor(chunk.chunkIndex / 2) + 1}`
      );
      factsByChunk.push(facts);
    }

    // Merge overlapping facts
    const facts = mergeChunkFacts(factsByChunk);
    const recorded = await this.recordFacts(input, text, facts);

    return {
      chunksProcessed: chunks.length,
      facts,
      processingTimeMs: Date.now() - startTime,
      warnings: warnings.length > 0 ? warnings : undefined,
      ...recorded,
    };
  }

  async ingestImage(input: IngestImageInput): Promise<IngestContentResult> {
    const startTime = Date.now();

    const mimeType = input.mimeType || 'image/png';
    const dataUrl = `data:${mimeType};base64,${input.imageBase64}`;

    const prompt = input.analysisPrompt || 
      'Analyze this image and extract key facts, information, or notable details. Return each fact on a new line.';

    // Use vision model
    const response = await this.extractFactsFromImage(prompt, dataUrl);

    const facts = this.parseFactsFromResponse(response, 'image_analysis');
    const recorded = await this.recordFacts(input, input.imageBase64, facts);

    return {
      chunksProcessed: 1,
      facts,
      processingTimeMs: Date.now() - startTime,
      ...recorded,
    };
  }

  async ingestText(input: IngestTextInput): Promise<IngestContentResult> {
    const startTime = Date.now();

    const chunks = chunkText(input.text);
    const factsByChunk: IngestedFact[][] = [];

    for (const chunk of chunks) {
      const facts = await this.extractFactsFromText(
        chunk.text,
        undefined,
        `chunk:${chunk.chunkIndex}`
      );
      factsByChunk.push(facts);
    }

    const facts = mergeChunkFacts(factsByChunk);
    const recorded = await this.recordFacts(input, input.text, facts);

    return {
      chunksProcessed: chunks.length,
      facts,
      processingTimeMs: Date.now() - startTime,
      ...recorded,
    };
  }

  async ingestURL(input: IngestURLInput): Promise<IngestContentResult> {
    const startTime = Date.now();

    if (!this.httpClient) {
      throw new Error('HTTP client not available for URL fetch');
    }

    const response = await this.fetchUrl(input.url);
    const html = Buffer.isBuffer(response) ? response.toString('utf8') : response;
    
    // Basic HTML to text conversion
    const text = this.htmlToText(html);

    const chunks = chunkText(text);
    const factsByChunk: IngestedFact[][] = [];

    for (const chunk of chunks) {
      const facts = await this.extractFactsFromText(
        chunk.text,
        undefined,
        input.url
      );
      factsByChunk.push(facts);
    }

    const facts = mergeChunkFacts(factsByChunk);
    const recorded = await this.recordFacts(input, text, facts);

    return {
      chunksProcessed: chunks.length,
      facts,
      processingTimeMs: Date.now() - startTime,
      ...recorded,
    };
  }

  getSupportedTypes(): IngestibleContentType[] {
    const types: IngestibleContentType[] = ['text'];
    
    if (this.pdfParser) types.push('pdf');
    if (this.httpClient) types.push('url');
    
    // Image is always supported via LLM vision
    types.push('image');
    
    return types;
  }

  private async recordFacts(
    input: IngestContentInput,
    content: string,
    facts: IngestedFact[],
  ): Promise<Pick<IngestContentResult, 'stored' | 'duplicates' | 'rejected' | 'originEventId'>> {
    if (!this.recorder) return {};
    const begun = await this.recorder.begin({
      tenantId: input.tenantId,
      userId: input.userId,
      contentType: input.contentType,
      contentHash: createHash('sha256').update(content).digest('hex'),
      correlationId: input.correlationId,
    });
    let stored = 0;
    let duplicates = 0;
    const reasons = new Map<string, number>();
    const untrusted = input.contentType !== 'text';
    for (const fact of facts) {
      const decision = await this.recorder.propose({
        tenantId: input.tenantId,
        userId: input.userId,
        originEventId: begun.originEventId,
        fact: fact.fact,
        confidence: fact.confidence,
        confirmed: input.confirmed,
        untrusted,
        correlationId: input.correlationId,
      });
      if (decision.alreadyStored) {
        duplicates += 1;
      } else if (decision.accepted) {
        stored += 1;
      } else {
        const reason = decision.reason ?? 'rejected';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
    const rejected: IngestRejection[] = [...reasons.entries()].map(([reason, count]) => ({ reason, count }));
    return { stored, duplicates, rejected, originEventId: begun.originEventId };
  }

  private async extractFactsFromText(
    text: string,
    customPrompt?: string,
    sourceRef?: string
  ): Promise<IngestedFact[]> {
    const prompt = customPrompt ||
      'Extract key facts from the following text. Return each fact on a new line, starting with "- ".\n\nText:\n' + text;

    const response = await this.generateText(prompt);

    return this.parseFactsFromResponse(response, sourceRef);
  }

  private async generateText(prompt: string): Promise<string> {
    if (typeof this.llmClient.generateText === 'function') {
      const response = await this.llmClient.generateText(prompt);
      return response.text;
    }

    if (typeof this.llmClient.chat === 'function') {
      return this.llmClient.chat([{ role: 'user', content: prompt }]);
    }

    throw new Error('LLM client does not support text generation');
  }

  private async extractFactsFromImage(prompt: string, dataUrl: string): Promise<string> {
    if (typeof this.llmClient.generateMultimodalChat === 'function') {
      const response = await this.llmClient.generateMultimodalChat([
        {
          role: 'user',
          parts: [
            { type: 'text', text: prompt },
            { type: 'image', imageBase64: dataUrl },
          ],
        },
      ]);
      return response.text;
    }

    if (typeof this.llmClient.chat === 'function') {
      return this.llmClient.chat([
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ]);
    }

    throw new Error('LLM client does not support image analysis');
  }

  private async fetchUrl(url: string, responseType?: 'buffer'): Promise<string | Buffer> {
    assertPublicHttpUrl(url);
    await this.validateRemoteUrl?.(url);
    if (typeof this.httpClient?.get === 'function') {
      const response = await this.httpClient.get(url);
      if (response.status !== 200) {
        throw new Error(`Failed to fetch URL: ${response.status}`);
      }
      return response.data;
    }

    if (typeof this.httpClient?.request === 'function') {
      const response = await this.httpClient.request({ method: 'GET', url, responseType });
      if (response.statusCode !== 200) {
        throw new Error(`Failed to fetch URL: ${response.statusCode}`);
      }
      return response.body;
    }

    throw new Error('HTTP client not available for URL fetch');
  }

  private parseFactsFromResponse(response: string, sourceRef?: string): IngestedFact[] {
    const lines = response.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => line.replace(/^[-•*]\s*/, ''));

    return lines.map(fact => ({
      id: uuidv4(),
      fact,
      sourceRef,
      confidence: 0.8, // Default confidence
    }));
  }

  private htmlToText(html: string): string {
    // Simple HTML to text conversion
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
