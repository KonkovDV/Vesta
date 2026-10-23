/**
 * Контекст для оценки feature-флагов.
 * Layer: Domain
 *
 * Используется стратегиями фича-флагов и менеджером фич.
 */
export interface FeatureContext {
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  region?: string;
  attributes?: Record<string, unknown>;
}