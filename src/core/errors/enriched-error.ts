/**
 * Standard interface for errors with additional metadata.
 * Used to eliminate `as any` casting when accessing error codes or status.
 */
export interface EnrichedError extends Error {
  code?: string;
  status?: number;
  originalError?: unknown;
  [key: string]: unknown;
}

/**
 * Type guard to check if an error is an EnrichedError.
 * Returns true only when the Error carries at least one enrichment property.
 */
export function isEnrichedError(error: unknown): error is EnrichedError {
  if (!(error instanceof Error)) return false;
  const e = error as unknown as Record<string, unknown>;
  return 'code' in e || 'status' in e || 'originalError' in e;
}
