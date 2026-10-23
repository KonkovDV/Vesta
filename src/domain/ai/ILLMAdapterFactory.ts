import type {
  ILLMAdapter,
  LLMMultimodalGenerateOptions,
} from './ILLMAdapter';

/**
 * Domain-level abstraction for LLM adapter factory.
 *
 * Implemented by infrastructure-level LLMAdapterFactory and exposed
 * via DI token 'ILLMAdapterFactory'.
 */
export interface ILLMAdapterFactory {
  /**
   * Resolve an LLM adapter with optional provider preference and multimodal hints.
   *
   * Implementation may perform health checks and capability-based routing.
   */
  createAdapterWithFailover(
    preferredProvider?: string,
    options?: LLMMultimodalGenerateOptions
  ): Promise<{
    adapter: ILLMAdapter;
    provider: string;
  }>;
}