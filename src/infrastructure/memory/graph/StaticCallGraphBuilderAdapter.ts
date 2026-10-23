/**
 * Infrastructure adapter: Static Call Graph Builder.
 *
 * Builds practical caller -> callee edges from AST-derived call sites.
 * Resolution is intentionally conservative: exact symbol-name matches are
 * accepted, ambiguous or unresolved cases are counted but not hallucinated.
 *
 * @see domain/memory/IStaticCallGraphBuilder.ts
 * @see domain/memory/ITreeSitterParser.ts
 * Layer: Infrastructure
 */

import type {
  IStaticCallGraphBuilder,
  BuildCallGraphInput,
  CallGraphResult,
} from '../../../domain/memory/IStaticCallGraphBuilder';

export class StaticCallGraphBuilderAdapter implements IStaticCallGraphBuilder {
  async buildCallGraph(input: BuildCallGraphInput): Promise<CallGraphResult> {
    const start = performance.now();
    const dedup = new Map<string, CallGraphResult['edges'][number]>();
    let unresolvedCount = 0;

    let totalCallSites = 0;
    for (const [callerFile, sites] of input.callSitesByFile.entries()) {
      totalCallSites += sites.length;

      for (const site of sites) {
        const resolvedFile = input.symbolIndex.get(site.calleeName);
        if (!resolvedFile) {
          unresolvedCount++;
          continue;
        }

        const confidence = site.isExternalCall
          ? 0.9
          : resolvedFile === callerFile
            ? 1.0
            : 0.85;

        const edge = {
          callerFqn: site.callerName,
          calleeFqn: site.calleeName,
          callerFile,
          calleeFile: resolvedFile,
          confidence,
          isCrossModule: resolvedFile !== callerFile,
        };
        dedup.set(`${edge.callerFile}|${edge.callerFqn}|${edge.calleeFile}|${edge.calleeFqn}`, edge);
      }
    }

    return {
      edges: [...dedup.values()],
      unresolvedCount,
      fileCount: input.callSitesByFile.size,
      totalCallSites,
      durationMs: Math.round(performance.now() - start),
    };
  }
}
