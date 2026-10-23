/**
 * MdcDirectiveParser — Parse @import and @file directives from MDC content.
 *
 * Supports two directive types:
 * - `@import(mdcName, "Section Title")` — inline a section from another .mdc file
 * - `@file(relativePath, "jsonKey|sectionTitle")` — inline content from an external file
 *
 * Directives must appear on their own line. Surrounding content is preserved as cleanContent.
 *
 * @layer Infrastructure/Context
 * @phase 4 — V3 Context Engineering: Dynamic MDC Compilation
 */

// ── Types ───────────────────────────────────────────────────────────

export type DirectiveType = 'import' | 'file';

export interface MdcDirective {
  /** Directive type: 'import' (cross-MDC) or 'file' (external file) */
  readonly type: DirectiveType;
  /** Source MDC name (for @import) or relative file path (for @file) */
  readonly source: string;
  /** Optional section/key filter */
  readonly section?: string;
  /** 1-based line number in original content */
  readonly line: number;
  /** Raw directive text */
  readonly raw: string;
}

export interface ParsedMdc {
  /** Extracted directives */
  readonly directives: readonly MdcDirective[];
  /** Content with directives removed (marker comments left in place) */
  readonly cleanContent: string;
}

// ── Directive Patterns ──────────────────────────────────────────────

/**
 * @import(mdcName, "Section Title")
 * Captures: [1] mdcName, [2] section title
 */
const IMPORT_REGEX = /^@import\((\w[\w-]*),\s*"([^"]+)"\)\s*$/;

/**
 * @file(path/to/file, "key|section")
 * Captures: [1] file path, [2] key or section title
 */
const FILE_REGEX = /^@file\(([^,]+),\s*"([^"]+)"\)\s*$/;

// ── Parser ──────────────────────────────────────────────────────────

/**
 * Parse MDC content for @import and @file directives.
 *
 * Each directive is extracted from its line and replaced with a placeholder
 * comment `<!-- @directive:source -->` for later resolution by MdcCompiler.
 *
 * @param content — raw MDC file content (with frontmatter already stripped)
 * @returns parsed directives and clean content
 */
export function parseDirectives(content: string): ParsedMdc {
  const directives: MdcDirective[] = [];
  const lines = content.split('\n');
  const outputLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const importMatch = trimmed.match(IMPORT_REGEX);
    if (importMatch) {
      directives.push({
        type: 'import',
        source: importMatch[1],
        section: importMatch[2],
        line: i + 1,
        raw: trimmed,
      });
      outputLines.push(`<!-- @import:${importMatch[1]}#${importMatch[2]} -->`);
      continue;
    }

    const fileMatch = trimmed.match(FILE_REGEX);
    if (fileMatch) {
      directives.push({
        type: 'file',
        source: fileMatch[1].trim(),
        section: fileMatch[2],
        line: i + 1,
        raw: trimmed,
      });
      outputLines.push(`<!-- @file:${fileMatch[1].trim()}#${fileMatch[2]} -->`);
      continue;
    }

    outputLines.push(line);
  }

  return {
    directives,
    cleanContent: outputLines.join('\n'),
  };
}

/**
 * Extract a named section from markdown content.
 *
 * Finds the first heading matching `sectionTitle` (case-insensitive)
 * and returns all content until the next heading of same or higher level.
 *
 * @param content — full markdown content
 * @param sectionTitle — heading text to search for
 * @returns section content (excluding the heading itself), or empty string
 */
export function extractSection(content: string, sectionTitle: string): string {
  const lines = content.split('\n');
  const lowerTitle = sectionTitle.toLowerCase().trim();
  let capturing = false;
  let captureLevel = 0;
  const captured: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim().toLowerCase();

      if (!capturing && title === lowerTitle) {
        capturing = true;
        captureLevel = level;
        continue; // skip the heading itself
      } else if (capturing && level <= captureLevel) {
        break; // reached next section of same/higher level
      }
    }

    if (capturing) {
      captured.push(line);
    }
  }

  return captured.join('\n').trim();
}

/**
 * Extract a value from a JSON file by top-level key.
 * Returns stringified result for embedding in MDC.
 *
 * @param jsonContent — raw JSON string
 * @param key — top-level key to extract
 * @returns formatted JSON string, or empty string if key not found
 */
export function extractJsonKey(jsonContent: string, key: string): string {
  try {
    const data = JSON.parse(jsonContent);
    if (key in data) {
      const value = data[key];
      return typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
    }
    return '';
  } catch {
    return '';
  }
}
