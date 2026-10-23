import { createHash } from 'crypto';
import * as path from 'path';

import type {
  ICodePathContextResolver,
  CodePathContextRequest,
  CodePathContextResult,
  CodePathContextSnippet,
} from '../../../domain/memory/ICodePathContextResolver';
import type { ITreeSitterParser, AstSymbol } from '../../../domain/memory/ITreeSitterParser';
import type { ICodeGraphStore, CodeGraphNode } from '../../../domain/memory/ICodeGraphStore';

const DEFAULT_MAX_IMPORTED_SNIPPETS = 3;
const DEFAULT_MAX_SNIPPETS = 8;

interface ImportDefinition {
  readonly modulePath: string;
  readonly importedNames: readonly string[];
}

function symbolContainsLine(symbol: AstSymbol, line: number): boolean {
  return line >= symbol.range.start.row && line <= symbol.range.end.row;
}

function compareSymbolSpecificity(a: AstSymbol, b: AstSymbol): number {
  if (a.range.start.row !== b.range.start.row) {
    return a.range.start.row - b.range.start.row;
  }

  return b.range.end.row - a.range.end.row;
}

function buildSymbolName(symbol: AstSymbol): string {
  return symbol.parentName ? `${symbol.parentName}.${symbol.name}` : symbol.name;
}

function sliceContentByLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(startLine - 1, endLine).join('\n').trim();
}

function dedupeSnippets(snippets: readonly CodePathContextSnippet[]): CodePathContextSnippet[] {
  const seen = new Set<string>();
  const result: CodePathContextSnippet[] = [];

  for (const snippet of snippets) {
    const key = [snippet.source, snippet.filePath, snippet.symbolName ?? '', snippet.content].join('::');
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(snippet);
  }

  return result;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function parseImportedNames(bindings: string): string[] {
  const importedNames: string[] = [];
  const namedMatch = bindings.match(/\{([^}]+)\}/);
  if (namedMatch) {
    const names = namedMatch[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/\s+as\s+/i)[0]?.trim())
      .filter((part): part is string => Boolean(part));
    importedNames.push(...names);
  }

  const namespaceMatch = bindings.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceMatch) {
    importedNames.push(namespaceMatch[1]);
  }

  const withoutNamed = bindings.replace(/\{[^}]+\}/g, '').trim();
  const defaultCandidate = withoutNamed
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !part.startsWith('*'));
  if (defaultCandidate) {
    importedNames.push(defaultCandidate);
  }

  return [...new Set(importedNames)];
}

function extractImportDefinitions(content: string): ImportDefinition[] {
  const definitions: ImportDefinition[] = [];
  const importRegex = /import\s+([\s\S]*?)\s+from\s+['"]([^'"\n]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const bindings = match[1]?.trim() ?? '';
    const modulePath = match[2]?.trim() ?? '';
    if (!modulePath) {
      continue;
    }

    definitions.push({
      modulePath,
      importedNames: parseImportedNames(bindings),
    });
  }

  return definitions;
}

function buildSearchQueries(definition: ImportDefinition): string[] {
  if (definition.importedNames.length > 0) {
    return [...definition.importedNames];
  }

  return [definition.modulePath];
}

function buildModuleCandidates(filePath: string, modulePath: string): string[] {
  if (!modulePath.startsWith('.')) {
    return [];
  }

  const normalizedFilePath = normalizePath(filePath);
  const fileDir = path.posix.dirname(normalizedFilePath);
  const baseResolved = normalizePath(path.posix.normalize(path.posix.join(fileDir, modulePath)));
  return [
    baseResolved,
    `${baseResolved}.ts`,
    `${baseResolved}.tsx`,
    `${baseResolved}.js`,
    `${baseResolved}.jsx`,
    `${baseResolved}/index.ts`,
    `${baseResolved}/index.tsx`,
    `${baseResolved}/index.js`,
    `${baseResolved}/index.jsx`,
  ];
}

function matchesModuleCandidate(candidatePath: string, candidates: readonly string[]): boolean {
  const normalizedCandidate = normalizePath(candidatePath);
  return candidates.some((candidate) => {
    const normalizedExpected = normalizePath(candidate);
    return normalizedCandidate === normalizedExpected || normalizedCandidate.endsWith(`/${normalizedExpected}`);
  });
}

export class CodePathContextResolverAdapter implements ICodePathContextResolver {
  private readonly cache = new Map<string, readonly CodePathContextSnippet[]>();

  constructor(
    private readonly parser: ITreeSitterParser,
    private readonly graphStore: ICodeGraphStore,
  ) {}

  async resolve(input: CodePathContextRequest): Promise<CodePathContextResult> {
    const parsed = await this.parser.parseFile({
      filePath: input.filePath,
      content: input.content,
      tenantId: input.tenantId,
      correlationId: input.correlationId,
    });

    const enclosingSymbols = parsed.symbols
      .filter((symbol) => symbolContainsLine(symbol, input.line))
      .sort(compareSymbolSpecificity);
    const importDefinitions = extractImportDefinitions(input.content);

    const cacheKey = this.buildCacheKey(input, enclosingSymbols, importDefinitions);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return {
        snippets: cached,
        cacheKey,
        cacheHit: true,
      };
    }

    const localSnippets = enclosingSymbols
      .map((symbol) => ({
        filePath: input.filePath,
        content: sliceContentByLines(input.content, symbol.range.start.row, symbol.range.end.row),
        source: 'local-symbol' as const,
        symbolName: buildSymbolName(symbol),
        startLine: symbol.range.start.row,
        endLine: symbol.range.end.row,
      }))
      .filter((snippet) => snippet.content.length > 0);

    const importedSnippets = await this.resolveImportedSnippets(input, importDefinitions);
    const snippets = dedupeSnippets([...localSnippets, ...importedSnippets])
      .slice(0, input.maxSnippets ?? DEFAULT_MAX_SNIPPETS);

    this.cache.set(cacheKey, snippets);
    return {
      snippets,
      cacheKey,
      cacheHit: false,
    };
  }

  invalidate(filePath?: string): void {
    if (!filePath) {
      this.cache.clear();
      return;
    }

    for (const key of this.cache.keys()) {
      if (key.includes(filePath)) {
        this.cache.delete(key);
      }
    }
  }

  private buildCacheKey(
    input: CodePathContextRequest,
    symbols: readonly AstSymbol[],
    importDefinitions: readonly ImportDefinition[],
  ): string {
    const symbolFingerprint = symbols
      .map((symbol) => `${buildSymbolName(symbol)}:${symbol.range.start.row}:${symbol.range.end.row}`)
      .join('|');
    const importFingerprint = importDefinitions
      .map((definition) => `${definition.modulePath}:${definition.importedNames.join(',')}`)
      .join('|');
    const ignoredFingerprint = (input.ignoredFilePaths ?? [])
      .map((ignoredPath) => normalizePath(ignoredPath))
      .sort()
      .join('|');
    const digest = createHash('sha256')
      .update(input.filePath)
      .update(String(input.line))
      .update(symbolFingerprint)
      .update(importFingerprint)
      .update(ignoredFingerprint)
      .digest('hex');

    return `${input.filePath}:${digest}`;
  }

  private async resolveImportedSnippets(
    input: CodePathContextRequest,
    importDefinitions: readonly ImportDefinition[],
  ): Promise<readonly CodePathContextSnippet[]> {
    const importedSnippets: CodePathContextSnippet[] = [];
    const maxImportedSnippets = input.maxImportedSnippets ?? DEFAULT_MAX_IMPORTED_SNIPPETS;
    const ignoredPaths = new Set((input.ignoredFilePaths ?? []).map((ignoredPath) => normalizePath(ignoredPath)));

    for (const definition of importDefinitions) {
      const moduleCandidates = buildModuleCandidates(input.filePath, definition.modulePath);
      const queries = buildSearchQueries(definition);

      for (const query of queries) {
        const nodes = await this.graphStore.hybridSearch({
          tenantId: input.tenantId,
          query,
          limit: maxImportedSnippets,
          correlationId: input.correlationId,
        });

        for (const node of nodes) {
          const snippet = this.toImportedSnippet(node, moduleCandidates, definition.importedNames, input, ignoredPaths);
          if (!snippet) {
            continue;
          }

          importedSnippets.push(snippet);
        }
      }
    }

    return importedSnippets;
  }

  private toImportedSnippet(
    node: CodeGraphNode,
    moduleCandidates: readonly string[],
    importedNames: readonly string[],
    input: CodePathContextRequest,
    ignoredPaths: ReadonlySet<string>,
  ): CodePathContextSnippet | null {
    if (!node.content || node.content.trim().length === 0) {
      return null;
    }

    const normalizedNodePath = normalizePath(node.filePath);
    if (normalizedNodePath === normalizePath(input.filePath)) {
      return null;
    }

    if (ignoredPaths.has(normalizedNodePath)) {
      return null;
    }

    const matchesImportedName = importedNames.length > 0 && importedNames.includes(node.name);
    const matchesModulePath = moduleCandidates.length > 0 && matchesModuleCandidate(node.filePath, moduleCandidates);
    if (!matchesImportedName && !matchesModulePath) {
      return null;
    }

    return {
      filePath: node.filePath,
      content: node.content.trim(),
      source: 'imported-graph',
      symbolName: node.name,
      startLine: node.startLine,
      endLine: node.endLine,
    };
  }
}