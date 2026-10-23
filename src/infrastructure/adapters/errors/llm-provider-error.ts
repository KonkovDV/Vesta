/**
 * LLM Provider Error — KC-020.
 * Standardised error wrapper for LLM provider API failures.
 *
 * Extracted from KiloCode (Apache-2.0), adapted to MicroPhoenix error taxonomy.
 * Layer: Infrastructure
 *
 * Why this exists:
 * Different LLM providers throw SDK-specific errors with different shapes.
 * This module normalises them to a single `LLMProviderError` class that
 * preserves the HTTP status code, provider name, and structured details
 * needed for retry/backoff and user-facing error display.
 */

import { LLMAdapterError } from '@/domain/ai/ILLMAdapter';

/**
 * Extended LLM error that carries HTTP transport metadata.
 * Subclass of the domain `LLMAdapterError` so existing catch blocks still work.
 */
export class LLMProviderError extends LLMAdapterError {
  /** HTTP status code from the upstream API (e.g. 401, 429, 500). */
  readonly status?: number;

  /** Structured error details from the SDK (OpenAI `error` object, etc.). */
  readonly errorDetails?: unknown;

  /** Machine-readable error code (e.g. "rate_limit_exceeded"). */
  readonly code?: string;

  constructor(
    message: string,
    provider: string,
    operation: string,
    options?: {
      status?: number;
      code?: string;
      errorDetails?: unknown;
      cause?: Error;
    },
  ) {
    super(message, provider, operation, options?.cause);
    this.name = 'LLMProviderError';
    this.status = options?.status;
    this.code = options?.code;
    this.errorDetails = options?.errorDetails;
  }
}

/**
 * Options for `handleProviderError`.
 */
export interface HandleProviderErrorOptions {
  /** Custom prefix for the wrapping message (default: "completion"). */
  messagePrefix?: string;
}

/**
 * Wraps a provider SDK error into a uniform `LLMProviderError`.
 *
 * Preserves `.status`, `.errorDetails`, and `.code` from OpenAI-compatible SDKs
 * so that upstream callers can implement retry/back-off and meaningful UX.
 *
 * @param error      The caught exception (may be non-Error).
 * @param provider   Human-readable provider label (e.g. "DeepSeek", "Groq").
 * @param operation  Operation that failed (e.g. "generateText").
 * @param options    Optional message customisation.
 */
export function handleProviderError(
  error: unknown,
  provider: string,
  operation: string,
  options?: HandleProviderErrorOptions,
): LLMProviderError {
  const prefix = options?.messagePrefix ?? 'completion';

  if (error instanceof Error) {
    const anyErr = error as unknown as Record<string, unknown>;
    const rawMsg = (anyErr?.['error'] as Record<string, unknown>)?.['metadata'] as Record<string, unknown>;
    const msg = (rawMsg?.['raw'] as string) ?? error.message ?? '';

    const wrapped = new LLMProviderError(
      `${provider} ${prefix} error: ${msg}`,
      provider,
      operation,
      {
        status: typeof anyErr['status'] === 'number' ? anyErr['status'] : undefined,
        code: typeof anyErr['code'] === 'string' ? anyErr['code'] : undefined,
        errorDetails: anyErr['errorDetails'],
        cause: error,
      },
    );

    return wrapped;
  }

  // Non-Error exception
  return new LLMProviderError(
    `${provider} ${prefix} error: ${String(error)}`,
    provider,
    operation,
    {
      status: typeof (error as Record<string, unknown>)?.['status'] === 'number'
        ? (error as Record<string, unknown>)['status'] as number
        : undefined,
    },
  );
}
