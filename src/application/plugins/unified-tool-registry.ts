import type { PluginDescriptor } from './plugin-types';

class ToolRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryValidationError';
  }
}

export type ToolKind = 'local' | 'mcp';

export interface ToolRecord {
  toolId: string;
  kind: ToolKind;
  pluginDescriptor?: PluginDescriptor;
  metadata?: Record<string, unknown>;
}

/**
 * UnifiedToolRegistry — минимальный in-memory registry tool-ов
 * (локальные плагины и внешние MCP-инструменты).
 *
 * v1 семантика:
 * - инструменты индексируются по стабильному toolId (обычно "name@version");
 * - допускается несколько регистраций с одним toolId (конфликты имён);
 * - политика разрешения конфликтов при чтении детерминирована:
 *   - MCP-инструменты имеют приоритет над локальными;
 *   - при одинаковом типе побеждает первый зарегистрированный.
 */
export interface IUnifiedToolRegistry {
  registerTool(tool: ToolRecord): void;
  getToolById(toolId: string): ToolRecord | undefined;
  findToolsByKind(kind: ToolKind): ToolRecord[];
}

export class UnifiedToolRegistry implements IUnifiedToolRegistry {
  private readonly tools = new Map<string, ToolRecord[]>();

  registerTool(tool: ToolRecord): void {
    const id = tool.toolId.trim();
    if (!id) {
      throw new ToolRegistryValidationError('toolId must be a non-empty string');
    }

    const normalized: ToolRecord = {
      ...tool,
      toolId: id,
    };

    const existing = this.tools.get(id);
    if (existing) {
      existing.push(normalized);
    } else {
      this.tools.set(id, [normalized]);
    }
  }

  getToolById(toolId: string): ToolRecord | undefined {
    const id = toolId.trim();
    if (!id) {
      return undefined;
    }

    const candidates = this.tools.get(id);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }

    // Политика конфликтов:
    // - если есть хотя бы один MCP-инструмент, он имеет приоритет над локальным;
    // - при одинаковом типе (local vs local, mcp vs mcp) выигрывает первый зарегистрированный.
    let preferred: ToolRecord | undefined;

    for (const tool of candidates) {
      if (!preferred) {
        preferred = tool;
        continue;
      }

      if (preferred.kind === tool.kind) {
        continue;
      }

      if (tool.kind === 'mcp') {
        preferred = tool;
      }
    }

    return preferred;
  }

  findToolsByKind(kind: ToolKind): ToolRecord[] {
    const result: ToolRecord[] = [];

    for (const list of this.tools.values()) {
      for (const tool of list) {
        if (tool.kind === kind) {
          result.push(tool);
        }
      }
    }

    return result;
  }
}