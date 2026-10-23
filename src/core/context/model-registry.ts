/**
 * Shared Model Capability Registry — SSOT for all model context window sizes
 * and capability metadata.
 *
 * Both TokenBudgetManager (simple `maxInputTokens` lookup) and
 * HolographicContextAdapter (full capability profile) derive from this
 * single source of truth, eliminating MODEL_LIMITS / MODEL_CAPABILITIES duplication.
 *
 * @layer Core (shared kernel)
 * @pattern REC-089-13 Unified Model Registry
 */

// ── Model Capability Entry ──────────────────────────────────────────

/** Full capability profile for a single model. */
export interface ModelCapabilityEntry {
  /** Maximum input tokens (context window). */
  readonly maxInputTokens: number;
  /** Maximum output tokens. */
  readonly maxOutputTokens: number;
  /** Whether the provider supports prompt caching. */
  readonly supportsCaching: boolean;
  /** Whether the model natively handles structured graph input. */
  readonly supportsGraphInput: boolean;
  /** Tokens reserved for system prompt / tool definitions overhead. */
  readonly reservedTokens: number;
}

// ── Canonical Registry ──────────────────────────────────────────────

/**
 * Single source of truth for model context windows and capabilities.
 *
 * Convention:
 *   - Use the canonical model ID as key (e.g. 'gpt-4-turbo', 'claude-opus-4.6').
 *   - Aliases (e.g. 'claude-4.6-opus') point to the same entry values.
 *   - Add new models here; consumers auto-inherit the data.
 */
export const MODEL_REGISTRY: Readonly<Record<string, ModelCapabilityEntry>> = {
  // ── GPT Family ──────────────────────────────────────────────────
  'gpt-4': {
    maxInputTokens: 8_192,
    maxOutputTokens: 4_096,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 2_000,
  },
  'gpt-4-0613': {
    maxInputTokens: 8_192,
    maxOutputTokens: 4_096,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 2_000,
  },
  'gpt-4-32k': {
    maxInputTokens: 32_768,
    maxOutputTokens: 4_096,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 4_000,
  },
  'gpt-4-turbo': {
    maxInputTokens: 128_000,
    maxOutputTokens: 4_096,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 8_000,
  },
  'gpt-4-turbo-preview': {
    maxInputTokens: 128_000,
    maxOutputTokens: 4_096,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 8_000,
  },
  'gpt-4o': {
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 8_000,
  },
  'gpt-4o-mini': {
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 8_000,
  },
  'gpt-3.5-turbo': {
    maxInputTokens: 16_384,
    maxOutputTokens: 4_096,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 4_000,
  },
  'gpt-3.5-turbo-16k': {
    maxInputTokens: 16_384,
    maxOutputTokens: 4_096,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 4_000,
  },

  // ── Claude 3.x Family ──────────────────────────────────────────
  'claude-3-opus': {
    maxInputTokens: 200_000,
    maxOutputTokens: 4_096,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-3-sonnet': {
    maxInputTokens: 200_000,
    maxOutputTokens: 4_096,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-3-haiku': {
    maxInputTokens: 200_000,
    maxOutputTokens: 4_096,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-3.5-sonnet': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-3.5-haiku': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-3.5-opus': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },

  // ── Claude 4.x Family ──────────────────────────────────────────
  'claude-4-opus': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-4-sonnet': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-4.5-opus': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-4.5-sonnet': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-4.5-haiku': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-4.6-opus': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-4.6-sonnet': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-opus-4.6': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-sonnet-4.6': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },
  'claude-sonnet-4': {
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: false,
    reservedTokens: 10_000,
  },

  // ── Gemini Family ──────────────────────────────────────────────
  'gemini-2.0-pro': {
    maxInputTokens: 2_000_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: true,
    reservedTokens: 16_000,
  },
  'gemini-2.5-pro': {
    maxInputTokens: 1_000_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: true,
    reservedTokens: 16_000,
  },
  'gemini-2.0-flash': {
    maxInputTokens: 1_000_000,
    maxOutputTokens: 8_192,
    supportsCaching: true,
    supportsGraphInput: true,
    reservedTokens: 16_000,
  },

  // ── DeepSeek Family ────────────────────────────────────────────
  'deepseek-chat': {
    maxInputTokens: 128_000,
    maxOutputTokens: 8_192,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 8_000,
  },
  'deepseek-reasoner': {
    maxInputTokens: 128_000,
    maxOutputTokens: 8_192,
    supportsCaching: false,
    supportsGraphInput: false,
    reservedTokens: 8_000,
  },
};

// ── Helpers ─────────────────────────────────────────────────────────

/** Default fallback for unknown models. */
export const DEFAULT_MODEL_CAPABILITY: ModelCapabilityEntry = {
  maxInputTokens: 4_096,
  maxOutputTokens: 4_096,
  supportsCaching: false,
  supportsGraphInput: false,
  reservedTokens: 4_000,
};

/**
 * Lookup a model's context window size (maxInputTokens).
 * Returns the default (4096) for unknown models.
 */
export function getModelContextWindow(modelId: string): number {
  return (MODEL_REGISTRY[modelId] ?? DEFAULT_MODEL_CAPABILITY).maxInputTokens;
}

/**
 * Lookup full model capability entry.
 * Returns a default entry for unknown models (with the provided modelId).
 */
export function getModelCapability(modelId: string): ModelCapabilityEntry {
  return MODEL_REGISTRY[modelId] ?? DEFAULT_MODEL_CAPABILITY;
}
