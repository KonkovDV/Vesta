/**
 * MroProcessorAdapter — Infrastructure implementation of IMroProcessor.
 *
 * Computes C3-linearized method resolution order for classes with
 * multiple inheritance, mixins, or trait-based hierarchies.
 *
 * Layer: Infrastructure
 * Pattern source: GitNexus v1.4.0 ingestion/mro.ts (U14, patterns only)
 */

import type {
  IMroProcessor,
  MroClassEntry,
  MroResolutionResult,
  MroAlgorithm,
  MethodOverride,
  MroLanguage,
} from '../../../domain/memory/IMroProcessor';
import type { TenantId, CorrelationId } from '../../../domain/memory/session-types';

export class MroProcessorAdapter implements IMroProcessor {
  async resolve(input: {
    tenantId: TenantId;
    className: string;
    hierarchy: readonly MroClassEntry[];
    methodName?: string;
    correlationId: CorrelationId;
  }): Promise<MroResolutionResult> {
    const classMap = new Map<string, MroClassEntry>();
    for (const entry of input.hierarchy) {
      classMap.set(entry.name, entry);
    }

    const targetClass = classMap.get(input.className);
    if (!targetClass) {
      return {
        className: input.className,
        order: [input.className],
        algorithm: 'c3_linearization',
        overrides: [],
        hasDiamond: false,
        hasConflict: false,
        conflictDescription: `Class "${input.className}" not found in hierarchy`,
      };
    }

    const algorithm = this.selectAlgorithm(targetClass.language);

    let order: string[];
    let hasConflict = false;
    let conflictDescription: string | undefined;

    if (algorithm === 'c3_linearization') {
      const result = this.c3Linearize(input.className, classMap);
      order = result.order;
      hasConflict = result.hasConflict;
      conflictDescription = result.conflictDescription;
    } else if (algorithm === 'depth_first') {
      order = this.depthFirstOrder(input.className, classMap);
    } else {
      order = this.breadthFirstOrder(input.className, classMap);
    }

    const hasDiamond = this.detectDiamond(input.className, classMap);

    let overrides: MethodOverride[] = [];
    if (input.methodName) {
      overrides = this.resolveMethodOverrides(order, input.methodName, classMap);
    }

    return {
      className: input.className,
      order,
      algorithm,
      overrides,
      hasDiamond,
      hasConflict,
      conflictDescription,
    };
  }

  private selectAlgorithm(language: MroLanguage): MroAlgorithm {
    switch (language) {
      case 'python':
      case 'ruby':
        return 'c3_linearization';
      case 'cpp':
      case 'rust':
        return 'depth_first';
      case 'java':
      case 'kotlin':
      case 'typescript':
      case 'scala':
        return 'breadth_first';
      case 'elixir':
        // Elixir uses C3 for protocol and behaviour resolution
        return 'c3_linearization';
      default:
        return 'c3_linearization';
    }
  }

  /**
   * C3 linearization (MRO used by Python 3).
   * Merge algorithm: take head of first list if it doesn't appear
   * in the tail of any other list.
   */
  private c3Linearize(
    className: string,
    classMap: Map<string, MroClassEntry>,
  ): { order: string[]; hasConflict: boolean; conflictDescription?: string } {
    const entry = classMap.get(className);
    if (!entry || entry.bases.length === 0) {
      return { order: [className], hasConflict: false };
    }

    const parentLinearizations: string[][] = [];
    for (const base of entry.bases) {
      const parentResult = this.c3Linearize(base, classMap);
      if (parentResult.hasConflict) {
        return parentResult;
      }
      parentLinearizations.push([...parentResult.order]);
    }

    parentLinearizations.push([...entry.bases]);

    const result: string[] = [className];
    const lists = parentLinearizations;

    let maxIterations = 1000;
    while (lists.some(l => l.length > 0)) {
      if (--maxIterations <= 0) {
        return {
          order: result,
          hasConflict: true,
          conflictDescription: `C3 linearization exceeded max iterations for "${className}"`,
        };
      }

      let found = false;
      for (const list of lists) {
        if (list.length === 0) continue;
        const candidate = list[0];

        const inTail = lists.some(
          other => other.indexOf(candidate) > 0,
        );

        if (!inTail) {
          result.push(candidate);
          for (const l of lists) {
            const idx = l.indexOf(candidate);
            if (idx >= 0) l.splice(idx, 1);
          }
          found = true;
          break;
        }
      }

      if (!found) {
        const remaining = lists
          .filter(l => l.length > 0)
          .map(l => l.join(', '));
        return {
          order: result,
          hasConflict: true,
          conflictDescription:
            `C3 linearization conflict for "${className}": cannot merge [${remaining.join(' | ')}]`,
        };
      }
    }

    return { order: result, hasConflict: false };
  }

  /** Depth-first search for C++/Rust-style resolution. */
  private depthFirstOrder(
    className: string,
    classMap: Map<string, MroClassEntry>,
  ): string[] {
    const visited = new Set<string>();
    const order: string[] = [];

    const dfs = (name: string): void => {
      if (visited.has(name)) return;
      visited.add(name);
      order.push(name);
      const entry = classMap.get(name);
      if (entry) {
        for (const base of entry.bases) {
          dfs(base);
        }
      }
    };

    dfs(className);
    return order;
  }

  /** Breadth-first for Java/Kotlin/TS interface resolution. */
  private breadthFirstOrder(
    className: string,
    classMap: Map<string, MroClassEntry>,
  ): string[] {
    const visited = new Set<string>();
    const order: string[] = [];
    const queue: string[] = [className];

    while (queue.length > 0) {
      const name = queue.shift()!;
      if (visited.has(name)) continue;
      visited.add(name);
      order.push(name);
      const entry = classMap.get(name);
      if (entry) {
        for (const base of entry.bases) {
          if (!visited.has(base)) {
            queue.push(base);
          }
        }
      }
    }
    return order;
  }

  /** Detect diamond inheritance (any base reachable via 2+ paths). */
  private detectDiamond(
    className: string,
    classMap: Map<string, MroClassEntry>,
  ): boolean {
    const entry = classMap.get(className);
    if (!entry || entry.bases.length < 2) return false;

    const ancestorSets: Set<string>[] = entry.bases.map(base =>
      this.collectAllAncestors(base, classMap),
    );

    for (let i = 0; i < ancestorSets.length; i++) {
      for (let j = i + 1; j < ancestorSets.length; j++) {
        for (const ancestor of ancestorSets[i]) {
          if (ancestorSets[j].has(ancestor)) return true;
        }
      }
    }
    return false;
  }

  private collectAllAncestors(
    className: string,
    classMap: Map<string, MroClassEntry>,
  ): Set<string> {
    const ancestors = new Set<string>();
    const stack = [className];
    while (stack.length > 0) {
      const name = stack.pop()!;
      if (ancestors.has(name)) continue;
      ancestors.add(name);
      const entry = classMap.get(name);
      if (entry) {
        for (const base of entry.bases) {
          stack.push(base);
        }
      }
    }
    return ancestors;
  }

  /** Find classes in MRO that define the given method. */
  private resolveMethodOverrides(
    mroOrder: string[],
    methodName: string,
    classMap: Map<string, MroClassEntry>,
  ): MethodOverride[] {
    const overrides: MethodOverride[] = [];
    for (let i = 0; i < mroOrder.length; i++) {
      const entry = classMap.get(mroOrder[i]);
      if (entry) {
        overrides.push({
          className: entry.name,
          methodName,
          filePath: entry.filePath,
          line: 0,
          mroIndex: i,
        });
      }
    }
    return overrides;
  }
}
