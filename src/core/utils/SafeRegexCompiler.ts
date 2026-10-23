/**
 * SafeRegexCompiler — ReDoS-safe regex compilation with nested repetition detection
 *
 * Prevents catastrophic backtracking by detecting nested quantifiers
 * (e.g. `(a+)+`, `(a*)*b`) before compilation. Uses an LRU cache for
 * compiled patterns (max 256 entries).
 *
 * @module SafeRegexCompiler
 * @layer Core – Utils
 * @donor external/openclaw/src/security/safe-regex.ts (MIT)
 * @license MIT (OpenClaw)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QuantifierRead = {
  consumed: number;
  /** true for *, +, {n,} — can cause exponential backtracking when nested */
  unbounded: boolean;
};

type TokenState = {
  containsRepetition: boolean;
};

type ParseFrame = {
  lastToken: TokenState | null;
  containsRepetition: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAFE_REGEX_CACHE_MAX = 256;
const safeRegexCache = new Map<string, RegExp | null>();

// ---------------------------------------------------------------------------
// Nested Repetition Detection
// ---------------------------------------------------------------------------

function readQuantifier(source: string, index: number): QuantifierRead | null {
  const ch = source[index];
  if (ch === '*' || ch === '+') {
    return { consumed: source[index + 1] === '?' ? 2 : 1, unbounded: true };
  }
  if (ch === '?') {
    // ? = {0,1} — bounded quantifier, cannot cause exponential backtracking (OWASP)
    return { consumed: source[index + 1] === '?' ? 2 : 1, unbounded: false };
  }
  if (ch !== '{') {
    return null;
  }
  let i = index + 1;
  while (i < source.length && /\d/.test(source[i])) {
    i += 1;
  }
  if (i === index + 1) {
    return null;
  }
  if (source[i] === ',') {
    i += 1;
    while (i < source.length && /\d/.test(source[i])) {
      i += 1;
    }
  }
  if (source[i] !== '}') {
    return null;
  }
  i += 1;
  if (source[i] === '?') {
    i += 1;
  }
  return { consumed: i - index, unbounded: true };
}

/**
 * Check if a regex source contains nested repetition (potential ReDoS).
 *
 * Detects patterns like `(a+)+`, `(a*)*b`, `(x{2,})*` that can cause
 * catastrophic backtracking with O(2^n) runtime.
 *
 * @param source - Regex source string (without delimiters)
 * @returns true if nested repetition is detected
 */
export function hasNestedRepetition(source: string): boolean {
  if (!source) {
    return false;
  }

  const frames: ParseFrame[] = [{ lastToken: null, containsRepetition: false }];
  let inCharClass = false;

  const emitToken = (token: TokenState) => {
    const frame = frames[frames.length - 1];
    frame.lastToken = token;
    if (token.containsRepetition) {
      frame.containsRepetition = true;
    }
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    // Escaped character — skip next
    if (ch === '\\') {
      i += 1;
      emitToken({ containsRepetition: false });
      continue;
    }

    // Character class — skip until closing ]
    if (inCharClass) {
      if (ch === ']') {
        inCharClass = false;
      }
      continue;
    }

    if (ch === '[') {
      inCharClass = true;
      emitToken({ containsRepetition: false });
      continue;
    }

    // Group open
    if (ch === '(') {
      frames.push({ lastToken: null, containsRepetition: false });
      continue;
    }

    // Group close
    if (ch === ')') {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        emitToken({ containsRepetition: frame.containsRepetition });
      }
      continue;
    }

    // Alternation — reset last token
    if (ch === '|') {
      const frame = frames[frames.length - 1];
      frame.lastToken = null;
      continue;
    }

    // Quantifier check
    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      const frame = frames[frames.length - 1];
      const token = frame.lastToken;
      if (!token) {
        continue;
      }
      if (token.containsRepetition && quantifier.unbounded) {
        return true;
      }
      token.containsRepetition = true;
      frame.containsRepetition = true;
      i += quantifier.consumed - 1;
      continue;
    }

    emitToken({ containsRepetition: false });
  }

  return false;
}

// ---------------------------------------------------------------------------
// Safe Compilation
// ---------------------------------------------------------------------------

/**
 * Compile a regex pattern safely, rejecting patterns with nested repetition.
 *
 * Returns `null` if:
 * - The source is empty
 * - The pattern contains nested repetition (potential ReDoS)
 * - The pattern is syntactically invalid
 *
 * Results are cached (LRU, max 256 entries).
 *
 * @param source - Regex source string
 * @param flags - Optional regex flags (default: "")
 * @returns Compiled RegExp or null if unsafe/invalid
 */
export function compileSafeRegex(source: string, flags = ''): RegExp | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }

  const cacheKey = `${flags}::${trimmed}`;
  if (safeRegexCache.has(cacheKey)) {
    return safeRegexCache.get(cacheKey) ?? null;
  }

  let compiled: RegExp | null = null;
  if (!hasNestedRepetition(trimmed)) {
    try {
      compiled = new RegExp(trimmed, flags);
    } catch {
      compiled = null;
    }
  }

  safeRegexCache.set(cacheKey, compiled);
  if (safeRegexCache.size > SAFE_REGEX_CACHE_MAX) {
    const oldestKey = safeRegexCache.keys().next().value!;
    safeRegexCache.delete(oldestKey);
  }
  return compiled;
}

/**
 * Clear the internal regex compilation cache.
 * Primarily intended for testing.
 */
export function clearSafeRegexCache(): void {
  safeRegexCache.clear();
}
