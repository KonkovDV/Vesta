/**
 * IInputSanitizationPipeline — Domain port for composable input sanitization.
 *
 * AS-043 Input Sanitization Pipeline: manages a composable pipeline of
 * sanitization stages that transform untrusted content before it reaches
 * downstream consumers (e.g., IPromptInjectionScanner, LLM context).
 *
 * SOTA 2026 Basis: Anthropic claude-code-action employs a 7-stage sanitization
 * pipeline (stripHtmlComments → stripInvisibleCharacters → stripMarkdownImageAltText
 * → stripMarkdownLinkTitles → stripHiddenAttributes → normalizeHtmlEntities →
 * redactGitHubTokens) for preprocessing untrusted GitHub content before
 * feeding it to an agent. This domain port generalizes that pattern.
 *
 * Distinct from IPromptInjectionScanner: the scanner DETECTS injection patterns
 * in already-received content. This pipeline TRANSFORMS (sanitizes) content
 * before detection — removing invisible characters, normalizing encodings,
 * stripping hidden payloads, and redacting sensitive tokens. They compose:
 * sanitize(input) → scan(sanitized) → process(clean).
 *
 * Sub-capabilities:
 *   1. Pipeline Composition — ordered list of sanitization stages
 *   2. Stage Registration — add custom stages with name + transform
 *   3. Audit Trail — which stages applied, what characters removed/modified
 *   4. Channel Awareness — different pipeline configs per content source
 *   5. Stage Toggle — enable/disable individual stages at runtime
 *
 * @layer Domain (Security)
 * @pattern AS-043 Input Sanitization Pipeline (FITNESS-K: 84)
 * @see src/domain/security/prompt-injection-scanner.port.ts — injection detection (different concern)
 * @see src/infrastructure/security/PromptInjectionScanner.ts — infrastructure detection adapter
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Content source channel — determines which stages are applied.
 * Matches ExternalContentSource from prompt-injection-scanner.port.ts
 * for consistency across the security pipeline.
 */
export type SanitizationChannel =
  | 'github_comment'
  | 'github_pr_body'
  | 'tool_output'
  | 'user_input'
  | 'api_response'
  | 'file_content'
  | 'webhook_payload'
  | 'unknown';

// ─── Stage Definition ────────────────────────────────────────────────────────

/**
 * Definition of a single sanitization stage in the pipeline.
 * Stages are executed in registration order (priority-sorted).
 */
export interface SanitizationStageDefinition {
  /** Unique stage name (e.g., 'strip-html-comments', 'redact-tokens') */
  readonly name: string;
  /** Human-readable description of what this stage does */
  readonly description: string;
  /** Execution priority — lower numbers execute first (default: 100) */
  readonly priority: number;
  /** Whether this stage is currently active */
  readonly enabled: boolean;
  /** Which channels this stage applies to (empty = all channels) */
  readonly channels: readonly SanitizationChannel[];
}

// ─── Stage Result ────────────────────────────────────────────────────────────

/**
 * Result from applying a single sanitization stage to content.
 */
export interface StageSanitizationResult {
  /** Stage that was applied */
  readonly stageName: string;
  /** Whether the stage modified the content */
  readonly modified: boolean;
  /** Number of characters removed by this stage */
  readonly charactersRemoved: number;
  /** Number of characters added/changed by this stage */
  readonly charactersAdded: number;
  /** Duration of this stage in milliseconds */
  readonly durationMs: number;
}

// ─── Pipeline Input ──────────────────────────────────────────────────────────

/**
 * Input to the sanitization pipeline.
 */
export interface SanitizationInput {
  /** Raw untrusted content to sanitize */
  readonly content: string;
  /** Source channel (determines which stages apply) */
  readonly channel: SanitizationChannel;
  /** Optional correlation ID for audit trail */
  readonly correlationId?: string;
}

// ─── Pipeline Result ─────────────────────────────────────────────────────────

/**
 * Result of executing the full sanitization pipeline on content.
 */
export interface SanitizationResult {
  /** Sanitized output content */
  readonly sanitizedContent: string;
  /** Original content length (chars) */
  readonly originalLength: number;
  /** Sanitized content length (chars) */
  readonly sanitizedLength: number;
  /** Per-stage results in execution order */
  readonly stageResults: readonly StageSanitizationResult[];
  /** Total number of stages executed */
  readonly stagesExecuted: number;
  /** Total number of stages that modified content */
  readonly stagesModified: number;
  /** Total pipeline duration in milliseconds */
  readonly totalDurationMs: number;
  /** Channel that was used for stage selection */
  readonly channel: SanitizationChannel;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * Composable input sanitization pipeline.
 *
 * Transforms untrusted content through a series of ordered sanitization
 * stages before it reaches downstream consumers. Each stage is a pure
 * transform that removes or normalizes potentially dangerous content.
 *
 * Usage:
 * ```typescript
 * const result = await pipeline.sanitize({
 *   content: untrustedContent,
 *   channel: 'github_comment',
 *   correlationId: ctx.correlationId,
 * });
 * // result.sanitizedContent is now safe for further processing
 * ```
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface IInputSanitizationPipeline {
  /**
   * Execute the sanitization pipeline on untrusted input.
   * Only stages matching the input channel (or stages with no channel
   * restriction) are executed, in priority order.
   */
  sanitize(input: SanitizationInput): Promise<SanitizationResult>;

  /**
   * Register a custom sanitization stage.
   * Stages are sorted by priority (lower = earlier execution).
   */
  registerStage(stage: SanitizationStageDefinition): void;

  /**
   * Get all registered stages in execution order (sorted by priority).
   */
  getStages(): readonly SanitizationStageDefinition[];

  /**
   * Enable or disable a specific stage by name.
   * Returns false if the stage name is not found.
   */
  setStageEnabled(stageName: string, enabled: boolean): boolean;
}
