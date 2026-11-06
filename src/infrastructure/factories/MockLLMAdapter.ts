import { now } from '../../core/types';
import type {
  ILLMAdapter,
  LLMEmbeddingOptions,
  LLMEmbeddingResult,
  LLMGenerateOptions,
  LLMGenerationResult,
  LLMModelInfo,
  LLMModerationOptions,
  LLMModerationResult,
  LLMStreamCallback,
} from '../../domain/ai/ILLMAdapter';
import { BaseLLMAdapter } from '../../domain/ai/ILLMAdapter';

/**
 * Answers without calling a provider. Used when USE_MOCK_AI=true so the
 * factory and the services that take it can be constructed. The text is not
 * a model answer.
 */
export class MockLLMAdapter extends BaseLLMAdapter implements ILLMAdapter {
  async generateText(_prompt: string, options?: LLMGenerateOptions): Promise<LLMGenerationResult> {
    return this.result(options?.model);
  }

  async generateTextStream(
    prompt: string,
    callback: LLMStreamCallback,
    options?: LLMGenerateOptions,
  ): Promise<LLMGenerationResult> {
    const result = await this.generateText(prompt, options);
    callback(result.text);
    return result;
  }

  async generateEmbeddings(texts: string[], options?: LLMEmbeddingOptions): Promise<LLMEmbeddingResult> {
    return {
      embeddings: texts.map(() => [0]),
      model: options?.model ?? 'mock',
      usage: { promptTokens: 0, totalTokens: 0 },
      generatedAt: now(),
      metadata: { mock: true },
    };
  }

  async moderateContent(_content: string, _options?: LLMModerationOptions): Promise<LLMModerationResult> {
    return {
      approved: true,
      confidence: 0,
      categories: [],
      moderatedAt: now(),
      metadata: { mock: true },
    };
  }

  async getAvailableModels(): Promise<LLMModelInfo[]> {
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getProviderInfo(): { name: string; version: string; capabilities: string[] } {
    return { name: 'mock', version: '0', capabilities: [] };
  }

  private result(model?: string): LLMGenerationResult {
    return {
      text: '',
      model: model ?? 'mock',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      generatedAt: now(),
      finishReason: 'stop',
      metadata: { mock: true },
    };
  }
}
