/**
 * Express 5 types a path parameter as string | string[].
 * A named :id is one string. A repeated name can be an array;
 * handlers keep the first non-empty segment.
 * Layer: Core
 */
export function routeParam(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => item.length > 0);
    return first;
  }
  return undefined;
}
