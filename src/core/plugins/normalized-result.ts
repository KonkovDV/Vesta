// src/core/plugins/normalized-result.ts
export interface NormalizedResult<TData = unknown, TErrorDetail = Record<string, unknown>> {
  success: boolean;
  data: TData | null;
  error_detail?: TErrorDetail;
  metadata?: Record<string, unknown>;
}

export type NormalizedResultCore<TData = unknown> =
  Omit<NormalizedResult<TData>, 'metadata'>;