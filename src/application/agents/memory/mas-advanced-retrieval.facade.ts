/**
 * MasAdvancedRetrievalFacade — MAS/RAG-friendly application facade over AdvancedRetrievalUseCase.
 *
 * Layer: Application (MAS/MEM bridge)
 *
 * EV18.3: thin adapter so MAS/HTTP clients can call Advanced Retrieval without
 * touching IVectorStore or infra adapters directly.
 */
import type { AdvancedRetrievalResult } from '../../../domain/memory/AdvancedRetrievalService';
import type {
  AdvancedRetrievalUseCase,
  AdvancedRetrievalUseCaseInput,
} from '../../memory/advanced-retrieval.usecase';
import type { MasFilterBag } from '../types/mas-types';

export interface MasAdvancedRetrievalInput {
  tenantId: string;
  sessionId?: string;
  query: string;
  topK?: number;
  namespace?: string;
  filters?: MasFilterBag;
}

/**
 * Thin application-level facade for MAS/RAG flows.
 *
 * It does not add extra routing/branching; all normalization and validation
 * are delegated to AdvancedRetrievalUseCase.
 */
export class MasAdvancedRetrievalFacade {
  constructor(
    private readonly advancedRetrievalUseCase: AdvancedRetrievalUseCase,
  ) {}

  async executeForMas(
    input: MasAdvancedRetrievalInput,
  ): Promise<AdvancedRetrievalResult> {
    const useCaseInput: AdvancedRetrievalUseCaseInput = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      query: input.query,
      topK: input.topK,
      namespace: input.namespace,
      filters: input.filters,
    };

    return this.advancedRetrievalUseCase.execute(useCaseInput);
  }
}