
/**
 * Safely parses a string into an integer.
 * Returns the default value if the input is:
 * - undefined
 * - null
 * - empty string
 * - whitespace only
 * - results in NaN after parsing
 *
 * @param value - The string to parse
 * @param defaultValue - The fallback value to return if parsing fails
 * @param radix - Parsing radix (default: 10)
 */
export function safeParseInt<T = number>(
  value: string | undefined | null,
  defaultValue: T,
  radix = 10
): number | T {
  if (!value) {
    return defaultValue;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return defaultValue;
  }

  const parsed = Number.parseInt(trimmed, radix);
  
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }

  return parsed;
}
