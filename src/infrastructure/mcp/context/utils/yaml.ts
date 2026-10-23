/**
 * YAML serializer — lightweight, token-efficient output for MCP tools.
 *
 * Layer: Infrastructure (dev-time utility)
 *
 * Produces compact YAML without external dependencies (no js-yaml needed).
 * YAML is more token-efficient than JSON for LLM consumption.
 */

/**
 * Convert a JS object to compact YAML string.
 * Handles nested objects, arrays, and scalars.
 */
export function toYaml(obj: unknown, indent = 0): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return formatYamlString(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const prefix = ' '.repeat(indent);
    return obj
      .map((item) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const entries = Object.entries(item);
          if (entries.length === 0) return `${prefix}- {}`;
          const [firstKey, firstVal] = entries[0];
          const firstLine = `${prefix}- ${firstKey}: ${toYaml(firstVal, indent + 4)}`;
          const rest = entries
            .slice(1)
            .map(([k, v]) => `${prefix}  ${k}: ${toYaml(v, indent + 4)}`)
            .join('\n');
          return rest ? `${firstLine}\n${rest}` : firstLine;
        }
        return `${prefix}- ${toYaml(item, indent + 2)}`;
      })
      .join('\n');
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const prefix = ' '.repeat(indent);
    return entries
      .map(([key, val]) => {
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          return `${prefix}${key}:\n${toYaml(val, indent + 2)}`;
        }
        if (Array.isArray(val)) {
          if (val.length === 0) return `${prefix}${key}: []`;
          return `${prefix}${key}:\n${toYaml(val, indent + 2)}`;
        }
        return `${prefix}${key}: ${toYaml(val, indent + 2)}`;
      })
      .join('\n');
  }

  return String(obj);
}

const YAML_RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'True', 'False', 'Null', 'Yes', 'No', 'On', 'Off', 'TRUE', 'FALSE', 'NULL', 'YES', 'NO', 'ON', 'OFF']);

function formatYamlString(str: string): string {
  if (
    str.includes('\n') || str.includes(':') || str.includes('#') ||
    str.includes('"') || str.includes("'") ||
    YAML_RESERVED.has(str) || /^\d+(\.\d+)?$/.test(str) ||
    /^[{[!&*%@]/.test(str)
  ) {
    return `"${str.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return str;
}
