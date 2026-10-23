/**
 * Invisible Unicode Detection — detect zero-width and hidden Unicode characters.
 *
 * Layer: Core (Utility)
 * Origin: Hermes-Agent skills_guard.py + memory_tool.py — 19 invisible character codes.
 *
 * Invisible characters can be used for steganographic attacks:
 * - Hiding instructions in seemingly normal text
 * - Watermarking content invisibly
 * - Bypassing text-based security filters
 *
 * Pure utility — no external dependencies.
 */

// ── Invisible Character Set ──────────────────────────────────────────

/**
 * Set of Unicode code points that are invisible / zero-width.
 *
 * Source: Hermes-Agent skills_guard.py (19 characters).
 * These characters render as nothing in most fonts but are present in the string,
 * making them useful for steganography, prompt injection, and content manipulation.
 */
export const INVISIBLE_UNICODE_CHARS: ReadonlySet<string> = new Set([
  '\u200B', // Zero-width space
  '\u200C', // Zero-width non-joiner (ZWNJ)
  '\u200D', // Zero-width joiner (ZWJ)
  '\u200E', // Left-to-right mark (LRM)
  '\u200F', // Right-to-left mark (RLM)
  '\uFEFF', // Byte order mark (BOM) / zero-width no-break space
  '\u2060', // Word joiner
  '\u2061', // Function application
  '\u2062', // Invisible times
  '\u2063', // Invisible separator
  '\u2064', // Invisible plus
  '\u2066', // Left-to-right isolate
  '\u2067', // Right-to-left isolate
  '\u2068', // First strong isolate
  '\u2069', // Pop directional isolate
  '\u00AD', // Soft hyphen
  '\u034F', // Combining grapheme joiner
  '\u061C', // Arabic letter mark
  '\u180E', // Mongolian vowel separator
]);

const INVISIBLE_UNICODE_PATTERN = [...INVISIBLE_UNICODE_CHARS]
  .map((char) => '\\u{' + char.codePointAt(0)!.toString(16).toUpperCase() + '}')
  .join('|');

/**
 * Regex pattern matching any invisible Unicode character.
 * Pre-compiled for performance in repeated scans.
 */
const INVISIBLE_REGEX = new RegExp(INVISIBLE_UNICODE_PATTERN, 'gu');

// ── Types ────────────────────────────────────────────────────────────

export interface InvisibleCharInfo {
  /** The invisible character found */
  readonly char: string;
  /** Unicode code point (e.g., "U+200B") */
  readonly codePoint: string;
  /** Human-readable name */
  readonly name: string;
  /** Zero-based offset in the source string */
  readonly offset: number;
}

export interface InvisibleCharScanResult {
  /** Whether any invisible characters were found */
  readonly hasInvisible: boolean;
  /** Total count of invisible characters */
  readonly count: number;
  /** Distinct invisible characters found */
  readonly uniqueChars: readonly string[];
  /** Detailed info for each occurrence */
  readonly occurrences: readonly InvisibleCharInfo[];
}

// ── Character Names ──────────────────────────────────────────────────

const CHAR_NAMES: ReadonlyMap<string, string> = new Map([
  ['\u200B', 'Zero-width space'],
  ['\u200C', 'Zero-width non-joiner'],
  ['\u200D', 'Zero-width joiner'],
  ['\u200E', 'Left-to-right mark'],
  ['\u200F', 'Right-to-left mark'],
  ['\uFEFF', 'Byte order mark'],
  ['\u2060', 'Word joiner'],
  ['\u2061', 'Function application'],
  ['\u2062', 'Invisible times'],
  ['\u2063', 'Invisible separator'],
  ['\u2064', 'Invisible plus'],
  ['\u2066', 'Left-to-right isolate'],
  ['\u2067', 'Right-to-left isolate'],
  ['\u2068', 'First strong isolate'],
  ['\u2069', 'Pop directional isolate'],
  ['\u00AD', 'Soft hyphen'],
  ['\u034F', 'Combining grapheme joiner'],
  ['\u061C', 'Arabic letter mark'],
  ['\u180E', 'Mongolian vowel separator'],
]);

// ── Public API ───────────────────────────────────────────────────────

/**
 * Quick check — returns true if the text contains any invisible Unicode characters.
 *
 * This is the fastest check; use when you only need a boolean answer.
 *
 * @param text - Text to check
 * @returns true if any invisible character is found
 */
export function containsInvisibleUnicode(text: string): boolean {
  // Reset lastIndex since the regex is global
  INVISIBLE_REGEX.lastIndex = 0;
  return INVISIBLE_REGEX.test(text);
}

/**
 * Count the number of invisible Unicode characters in text.
 *
 * @param text - Text to scan
 * @returns Number of invisible characters found
 */
export function countInvisibleUnicode(text: string): number {
  INVISIBLE_REGEX.lastIndex = 0;
  const matches = text.match(INVISIBLE_REGEX);
  return matches ? matches.length : 0;
}

/**
 * Detailed scan — returns all invisible character occurrences with metadata.
 *
 * @param text - Text to scan
 * @returns Full scan result with character info and positions
 */
export function scanInvisibleUnicode(text: string): InvisibleCharScanResult {
  INVISIBLE_REGEX.lastIndex = 0;
  const occurrences: InvisibleCharInfo[] = [];
  const uniqueSet = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = INVISIBLE_REGEX.exec(text)) !== null) {
    const char = match[0];
    uniqueSet.add(char);
    occurrences.push({
      char,
      codePoint: `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
      name: CHAR_NAMES.get(char)!,
      offset: match.index,
    });
  }

  return {
    hasInvisible: occurrences.length > 0,
    count: occurrences.length,
    uniqueChars: [...uniqueSet],
    occurrences,
  };
}

/**
 * Strip all invisible Unicode characters from text.
 *
 * Useful for sanitizing content before storage or processing.
 *
 * @param text - Text to sanitize
 * @returns Sanitized text with all invisible characters removed
 */
export function stripInvisibleUnicode(text: string): string {
  INVISIBLE_REGEX.lastIndex = 0;
  return text.replace(INVISIBLE_REGEX, '');
}
