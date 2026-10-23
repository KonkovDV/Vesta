import type {
  ILLMAdapter,
  LLMMultimodalGenerateOptions,
} from '../../../domain/ai/ILLMAdapter';
import type {
  ILLMAdapterFactory as DomainILLMAdapterFactory,
} from '../../../domain/ai/ILLMAdapterFactory';

/**
 * Infrastructure-level LLM adapter factory contract.
 *
 * Extends the domain-level ILLMAdapterFactory with a legacy createAdapter method
 * used by existing infrastructure components (LLMArticleSummarizer, LLMTrendAnalyzer, DI bootstrap).
 */
export interface ILLMAdapterFactory extends DomainILLMAdapterFactory {
  /**
   * Legacy adapter creation API.
   *
   * Implementations should route to the same underlying providers as
   * createAdapterWithFailover, but may choose a concrete provider eagerly
   * based on preferredProvider and options.
   */
  createAdapter(
    preferredProvider: string,
    options?: LLMMultimodalGenerateOptions
  ): ILLMAdapter;
}