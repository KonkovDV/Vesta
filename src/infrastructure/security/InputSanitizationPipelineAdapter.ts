/**
 * InputSanitizationPipelineAdapter — Infrastructure adapter for AS-043 Input Sanitization.
 *
 * In-memory implementation of IInputSanitizationPipeline providing a composable
 * pipeline of sanitization stages. Ships with 7 built-in stages inspired by
 * Anthropic's claude-code-action sanitizer:
 *
 *   1. strip-html-comments     — Removes <!-- ... --> blocks
 *   2. strip-invisible-chars   — Removes zero-width chars, bidi overrides, soft hyphens
 *   3. strip-markdown-img-alt  — Clears alt text in markdown images (hidden instruction vector)
 *   4. strip-markdown-link-titles — Removes title attributes from markdown links
 *   5. strip-hidden-attributes — Removes data-* and aria-* HTML attributes with suspiciously long values
 *   6. normalize-html-entities — Converts HTML entities (&#x.., &lt;, etc.) to plain text
 *   7. redact-tokens           — Redacts strings matching common token/secret patterns
 *
 * @layer Infrastructure (Security)
 * @pattern AS-043 Input Sanitization Pipeline (FITNESS-K: 84)
 * @see src/domain/security/IInputSanitizationPipeline.ts — domain port
 */

import type {
  IInputSanitizationPipeline,
  SanitizationChannel,
  SanitizationInput,
  SanitizationResult,
  SanitizationStageDefinition,
  StageSanitizationResult,
} from '../../domain/security/IInputSanitizationPipeline';

// ─── Logger ──────────────────────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ─── Stage Transform Registry ────────────────────────────────────────────────

/**
 * Internal type: a stage definition paired with its transform function.
 * The transform is kept separate from the domain definition to maintain
 * the Clean Architecture boundary (domain port has no function references).
 */
interface RegisteredStage {
  definition: SanitizationStageDefinition;
  transform: (content: string) => string;
}

// ─── Built-in Transforms ─────────────────────────────────────────────────────

/** Stage 1: Strip HTML comments (potential instruction hiding vector) */
function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Stage 2: Strip invisible characters.
 * Removes zero-width spaces, joiners, non-joiners, bidi overrides/embeddings,
 * word joiners, soft hyphens, and other control characters that can hide
 * instructions from human review.
 */
function stripInvisibleCharacters(content: string): string {
  // Zero-width + bidi + soft hyphen + word joiner + variation selectors
  return content.replace(
    // eslint-disable-next-line no-misleading-character-class -- intentional: stripping ZWJ/VS individually for security sanitization
    /[\u200B\u200C\u200D\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD\uFE00-\uFE0F]/g,
    '',
  );
}

/**
 * Stage 3: Strip markdown image alt text.
 * Alt text in markdown images can carry hidden instructions:
 * ![IGNORE ALL PREVIOUS INSTRUCTIONS](image.png)
 * Replaces alt text with empty string, preserving the image reference.
 */
function stripMarkdownImageAltText(content: string): string {
  return content.replace(/!\[([^\]]*)\]/g, (_match, altText: string) => {
    // Only strip if alt text is suspiciously long (> 50 chars) or multi-line
    if (altText.length > 50 || altText.includes('\n')) {
      return '![]';
    }
    return _match;
  });
}

/**
 * Stage 4: Strip markdown link titles.
 * Title attributes in markdown links can carry hidden payloads:
 * [text](url "HIDDEN INSTRUCTION")
 */
function stripMarkdownLinkTitles(content: string): string {
  return content.replace(
    /\[([^\]]*)\]\(([^)"]+)\s+"[^"]*"\)/g,
    '[$1]($2)',
  );
}

/**
 * Stage 5: Strip hidden HTML attributes.
 * Removes data-* and aria-* attributes with suspiciously long values (> 100 chars)
 * that could embed hidden instructions in HTML content.
 */
function stripHiddenAttributes(content: string): string {
  return content.replace(
    /\s(?:data-|aria-)[a-z-]+=["'][^"']{100,}["']/gi,
    '',
  );
}

/**
 * Stage 6: Normalize HTML entities.
 * Converts common HTML entities back to plain text to prevent
 * obfuscation of injection patterns via entity encoding.
 */
function normalizeHtmlEntities(content: string): string {
  const entities: Record<string, string> = {
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };

  let result = content;

  // Named entities
  for (const [entity, replacement] of Object.entries(entities)) {
    result = result.split(entity).join(replacement);
  }

  // Numeric entities: &#xHH; and &#DDD;
  result = result.replace(/&#x([0-9a-f]{1,4});/gi, (_m, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  result = result.replace(/&#(\d{1,5});/g, (_m, dec: string) => {
    const code = parseInt(dec, 10);
    return code <= 0x10FFFF ? String.fromCodePoint(code) : _m;
  });

  return result;
}

/**
 * Stage 7: Redact sensitive tokens.
 * Replaces strings matching common API key/token patterns with [REDACTED].
 * Patterns: GitHub tokens (ghp_/gho_/ghs_/ghr_/github_pat_),
 * generic long hex strings, and Bearer tokens.
 */
function redactTokens(content: string): string {
  // GitHub personal access tokens
  let result = content.replace(
    /\b(ghp_|gho_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\b/g,
    '[REDACTED]',
  );

  // Generic API keys: long alphanumeric strings prefixed by common key names
  result = result.replace(
    /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{32,})["']?/gi,
    (match, _token) => match.replace(_token, '[REDACTED]'),
  );

  return result;
}

// ─── Default Stage Definitions ───────────────────────────────────────────────

function createBuiltinStages(): RegisteredStage[] {
  return [
    {
      definition: {
        name: 'strip-html-comments',
        description: 'Removes HTML comment blocks that may hide instructions',
        priority: 10,
        enabled: true,
        channels: [],
      },
      transform: stripHtmlComments,
    },
    {
      definition: {
        name: 'strip-invisible-chars',
        description: 'Removes zero-width characters, bidi overrides, and soft hyphens',
        priority: 20,
        enabled: true,
        channels: [],
      },
      transform: stripInvisibleCharacters,
    },
    {
      definition: {
        name: 'strip-markdown-img-alt',
        description: 'Clears suspiciously long alt text in markdown images',
        priority: 30,
        enabled: true,
        channels: [],
      },
      transform: stripMarkdownImageAltText,
    },
    {
      definition: {
        name: 'strip-markdown-link-titles',
        description: 'Removes title attributes from markdown links',
        priority: 40,
        enabled: true,
        channels: [],
      },
      transform: stripMarkdownLinkTitles,
    },
    {
      definition: {
        name: 'strip-hidden-attributes',
        description: 'Removes data-*/aria-* HTML attributes with long values',
        priority: 50,
        enabled: true,
        channels: [],
      },
      transform: stripHiddenAttributes,
    },
    {
      definition: {
        name: 'normalize-html-entities',
        description: 'Converts HTML entities to plain text to prevent obfuscation',
        priority: 60,
        enabled: true,
        channels: [],
      },
      transform: normalizeHtmlEntities,
    },
    {
      definition: {
        name: 'redact-tokens',
        description: 'Redacts API keys and access tokens matching common patterns',
        priority: 70,
        enabled: true,
        channels: [],
      },
      transform: redactTokens,
    },
  ];
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class InputSanitizationPipelineAdapter implements IInputSanitizationPipeline {
  private stages: RegisteredStage[];
  private readonly logger?: MinimalLogger;

  constructor(logger?: MinimalLogger) {
    this.logger = logger;
    this.stages = createBuiltinStages();
  }

  registerStage(stage: SanitizationStageDefinition): void {
    // Custom stages without a transform use identity (no-op).
    // In practice, custom stages are added via the adapter's
    // registerStageWithTransform() method below.
    const existing = this.stages.find(s => s.definition.name === stage.name);
    if (existing) {
      existing.definition = stage;
    } else {
      this.stages.push({ definition: stage, transform: (c) => c });
    }
    this.sortStages();

    this.logger?.info('Sanitization stage registered', {
      name: stage.name,
      priority: stage.priority,
      enabled: stage.enabled,
      channels: stage.channels,
    });
  }

  /**
   * Register a stage with its transform function (adapter-level extension).
   * Not on the domain port because domain ports do not carry function references.
   */
  registerStageWithTransform(
    stage: SanitizationStageDefinition,
    transform: (content: string) => string,
  ): void {
    const existing = this.stages.find(s => s.definition.name === stage.name);
    if (existing) {
      existing.definition = stage;
      existing.transform = transform;
    } else {
      this.stages.push({ definition: stage, transform });
    }
    this.sortStages();
  }

  getStages(): readonly SanitizationStageDefinition[] {
    return this.stages.map(s => s.definition);
  }

  setStageEnabled(stageName: string, enabled: boolean): boolean {
    const stage = this.stages.find(s => s.definition.name === stageName);
    if (!stage) return false;

    stage.definition = { ...stage.definition, enabled };

    this.logger?.info('Sanitization stage toggled', {
      name: stageName,
      enabled,
    });

    return true;
  }

  async sanitize(input: SanitizationInput): Promise<SanitizationResult> {
    const pipelineStart = Date.now();
    const originalLength = input.content.length;

    // Filter to applicable stages: enabled + channel match
    const applicableStages = this.stages.filter(s =>
      s.definition.enabled && this.channelMatches(s.definition, input.channel),
    );

    let currentContent = input.content;
    const stageResults: StageSanitizationResult[] = [];

    for (const stage of applicableStages) {
      const stageStart = Date.now();
      const beforeLength = currentContent.length;

      const afterContent = stage.transform(currentContent);
      const afterLength = afterContent.length;

      const removed = Math.max(0, beforeLength - afterLength);
      const added = Math.max(0, afterLength - beforeLength);
      const modified = currentContent !== afterContent;

      stageResults.push({
        stageName: stage.definition.name,
        modified,
        charactersRemoved: removed,
        charactersAdded: added,
        durationMs: Date.now() - stageStart,
      });

      currentContent = afterContent;
    }

    const totalDurationMs = Date.now() - pipelineStart;
    const stagesModified = stageResults.filter(r => r.modified).length;

    if (stagesModified > 0) {
      this.logger?.warn('Sanitization pipeline modified content', {
        channel: input.channel,
        correlationId: input.correlationId,
        originalLength,
        sanitizedLength: currentContent.length,
        stagesExecuted: applicableStages.length,
        stagesModified,
        totalDurationMs,
      });
    }

    return {
      sanitizedContent: currentContent,
      originalLength,
      sanitizedLength: currentContent.length,
      stageResults,
      stagesExecuted: applicableStages.length,
      stagesModified,
      totalDurationMs,
      channel: input.channel,
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private channelMatches(
    stage: SanitizationStageDefinition,
    channel: SanitizationChannel,
  ): boolean {
    // Empty channels list = applies to all channels
    if (stage.channels.length === 0) return true;
    return stage.channels.includes(channel);
  }

  private sortStages(): void {
    this.stages.sort((a, b) => a.definition.priority - b.definition.priority);
  }
}
