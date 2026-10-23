/**
 * AdvancedRetrievalUseCase — application-level facade over AdvancedRetrievalService.
 *
 * Layer: Application
 *
 * EV18.2: thin use case that:
 * - performs light input validation (empty string, max query length);
 * - delegates retrieval to domain AdvancedRetrievalService;
 * - is decoupled from infra and HTTP.
 */

import type {
  AdvancedRetrievalService,
  AdvancedRetrievalResult,
  AdvancedRetrievalRequest,
} from '../../domain/memory/AdvancedRetrievalService';

export interface AdvancedRetrievalUseCaseInput {
  tenantId: string;
  sessionId?: string;
  query: string;
  topK?: number;
  namespace?: string;
  filters?: Record<string, unknown>;
}

/**
 * Maximal длина запроса, чтобы предотвратить избыточные payload'ы на нижележащие слои.
 * При превышении строка аккуратно обрезается.
 */
export const ADVANCED_RETRIEVAL_MAX_QUERY_LENGTH = 4000;

export class AdvancedRetrievalUseCase {
  constructor(private readonly service: AdvancedRetrievalService) {}

  async execute(input: AdvancedRetrievalUseCaseInput): Promise<AdvancedRetrievalResult> {
    const trimmed = input.query.trim();
    if (!trimmed) {
      return { items: [] };
    }

    const normalizedQuery =
      trimmed.length > ADVANCED_RETRIEVAL_MAX_QUERY_LENGTH
        ? trimmed.slice(0, ADVANCED_RETRIEVAL_MAX_QUERY_LENGTH)
        : trimmed;

    const request: AdvancedRetrievalRequest = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      query: normalizedQuery,
      topK: input.topK,
      namespace: input.namespace,
      filters: input.filters,
    };

    return this.service.search(request);
  }
}