/**
 * Type guards for common patterns to replace unsafe `as` assertions.
 * Layer: Core
 */

/**
 * Safely checks if value is a non-null object.
 */
export function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Safely checks if value is a string.
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Safely checks if value is a number.
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

/**
 * Safely checks if value is a boolean.
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Safely checks if value is an array.
 */
export function isArray<T = unknown>(value: unknown): value is T[] {
  return Array.isArray(value);
}

/**
 * Type guard for Error instances.
 * Prevents unsafe `(error as Error).message` patterns.
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Safely extracts error message from unknown error.
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  if (isString(error)) {
    return error;
  }
  return 'Unknown error';
}

/**
 * Safely extracts error with potential status code.
 */
export interface ErrorWithStatus extends Error {
  status?: number;
  statusCode?: number;
}

export function isErrorWithStatus(error: unknown): error is ErrorWithStatus {
  return isError(error) && (typeof (error as ErrorWithStatus).status === 'number' || typeof (error as ErrorWithStatus).statusCode === 'number');
}

/**
 * Safely casts to Record<string, unknown> with runtime check.
 */
export function toRecord(value: unknown): Record<string, unknown> {
  if (isNonNullObject(value)) {
    return value;
  }
  return {};
}

/**
 * Validates and returns value if it matches expected enum values.
 */
export function validateEnum<T extends string>(
  value: unknown,
  validValues: readonly T[],
  defaultValue: T
): T {
  if (isString(value) && validValues.includes(value as T)) {
    return value as T;
  }
  return defaultValue;
}
