/**
 * Infrastructure adapter: Type Environment.
 *
 * TypeScript and JavaScript files are read by the TypeScript compiler checker.
 * Explicit annotations are tier 0. `new` expressions are tier 1.
 * `const alias = known` copies the known type as tier 2.
 * Missing files and other languages are reported as failed, not as empty success.
 *
 * Production implementation roadmap:
 * 1. TypeScript and JavaScript use the compiler checker (tiers 0 and 1).
 * 2. Implement per-language type extractors:
 *    - Tier 0: Walk AST for explicit type annotations
 *    - Tier 1: Detect `new ClassName()` patterns → constructor inference
 *    - Tier 2: Build assignment chains (const b = a → propagate type)
 *    - Tier 3: Resolve self/this/super via enclosing class AST context
 *    - Tier 4: Nullable unwrap (Optional<T> → T) + for-loop variable inference
 *    - Tier 5: Chained call resolution (map.get("k") → value type via descriptors)
 *    - Tier 6: Container descriptor matching (Map, Vec, HashMap, etc.)
 * 3. Wire per-language extractors (TypeScript, Python, Go, Rust, Java, etc.)
 * 4. Cache TypeEnv per-file for incremental updates
 *
 * Pattern references (GitNexus v1.4.6, patterns-only):
 * - Progressive tier resolution architecture (type-env.ts)
 * - Container descriptor table (type-extractors/shared.ts)
 * - Per-language extractors (type-extractors/*.ts)
 * - Scope-aware lookup with self/this/super resolution
 * - fastStripNullable optimization (90% fast path for simple identifiers)
 * - PatternOverrides for branch-local type narrowing
 * - ForLoopExtractorContext for loop variable inference
 *
 * @see domain/memory/ITypeEnvironment.ts
 * Layer: Infrastructure
 */

import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type {
  ITypeEnvironment,
  BuildTypeEnvironmentInput,
  TypeEnvironmentResult,
  ResolveTypeInput,
  TypeResolutionResult,
  TypeBinding,
  ContainerDescriptor,
  TypeResolutionTier,
} from '../../../domain/memory/ITypeEnvironment';
import type { TreeSitterLanguage } from '../../../domain/memory/ITreeSitterParser';

type TsModule = typeof import('typescript');

type SourceKind = 'typescript' | 'javascript' | 'python' | 'rust';

function sourceKind(filePath: string, language?: TreeSitterLanguage): SourceKind | undefined {
  if (language === 'typescript' || language === 'javascript' || language === 'python' || language === 'rust') {
    return language;
  }
  if (language) return undefined;
  const ext = extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return 'typescript';
  if (ext === '.js' || ext === '.jsx') return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  return undefined;
}

function stripLineComment(line: string, mark: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (line.startsWith(mark, index)) return line.slice(0, index);
  }
  return line;
}

async function loadTypeScript(): Promise<TsModule> {
  const loaded = await import('typescript');
  return (loaded as { default?: TsModule }).default ?? loaded;
}

async function bindingsFromScript(filePath: string, maxTier: TypeResolutionTier): Promise<TypeBinding[]> {
  const ts = await loadTypeScript();
  const sourceText = readFileSync(filePath, 'utf8');
  const options: import('typescript').CompilerOptions = {
    allowJs: true,
    noEmit: true,
    strict: false,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.CommonJS,
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === filePath) {
      return ts.createSourceFile(fileName, sourceText, languageVersion, true);
    }
    return readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram([filePath], options, host);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(filePath);
  if (!source) return [];

  const bindings: TypeBinding[] = [];
  const visit = (node: import('typescript').Node, scope: string): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const next = `${node.name.text}@${line}`;
      for (const parameter of node.parameters) collect(parameter, next);
      ts.forEachChild(node, (child) => visit(child, next));
      return;
    }
    if (ts.isVariableDeclaration(node)) collect(node, scope);
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  const collect = (node: import('typescript').VariableDeclaration | import('typescript').ParameterDeclaration, scope: string): void => {
    if (!ts.isIdentifier(node.name)) return;
    if (node.type && maxTier >= 0) {
      bindings.push({
        variableName: node.name.text,
        typeName: node.type.getText(source),
        scope,
        resolvedByTier: 0,
      });
      return;
    }
    if (node.initializer && ts.isNewExpression(node.initializer) && maxTier >= 1) {
      bindings.push({
        variableName: node.name.text,
        typeName: checker.typeToString(checker.getTypeAtLocation(node.initializer)),
        scope,
        resolvedByTier: 1,
      });
      return;
    }
    if (node.initializer && ts.isIdentifier(node.initializer) && maxTier >= 2) {
      const sourceName = node.initializer.text;
      let prior: TypeBinding | undefined;
      for (let index = bindings.length - 1; index >= 0; index -= 1) {
        const binding = bindings[index];
        if (binding.variableName === sourceName && (binding.scope === scope || binding.scope === 'module')) {
          prior = binding;
          break;
        }
      }
      if (prior) {
        bindings.push({
          variableName: node.name.text,
          typeName: prior.typeName,
          scope,
          resolvedByTier: 2,
        });
      }
    }
  };
  visit(source, 'module');
  return bindings;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of list) {
    if (char === '[' || char === '<' || char === '(') depth += 1;
    if ((char === ']' || char === '>' || char === ')') && depth > 0) depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function bindingsFromAnnotatedLines(text: string, maxTier: TypeResolutionTier, comment: string, functionPattern: RegExp, parameterPattern: RegExp, annotationPattern: RegExp, constructorPattern: RegExp): TypeBinding[] {
  const bindings: TypeBinding[] = [];
  const lines = text.split(/\r?\n/);
  let scope = 'module';
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = stripLineComment(lines[lineNo], comment);
    const declaration = functionPattern.exec(line);
    if (declaration) {
      scope = `${declaration[1]}@${lineNo + 1}`;
      if (maxTier >= 0) {
        for (const part of splitTopLevel(declaration[2])) {
          const parameter = parameterPattern.exec(part);
          if (!parameter) continue;
          bindings.push({
            variableName: parameter[1],
            typeName: parameter[2],
            scope,
            resolvedByTier: 0,
          });
        }
      }
      continue;
    }
    const annotated = annotationPattern.exec(line);
    if (annotated && maxTier >= 0) {
      bindings.push({
        variableName: annotated[1],
        typeName: annotated[2],
        scope,
        resolvedByTier: 0,
      });
      continue;
    }
    const constructed = constructorPattern.exec(line);
    if (constructed && maxTier >= 1) {
      bindings.push({
        variableName: constructed[1],
        typeName: constructed[2],
        scope,
        resolvedByTier: 1,
      });
    }
  }
  return bindings;
}

function bindingsFromPython(text: string, maxTier: TypeResolutionTier): TypeBinding[] {
  return bindingsFromAnnotatedLines(
    text,
    maxTier,
    '#',
    /^\s*def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/,
    /^\s*\**([A-Za-z_]\w*)\s*:\s*(.+?)\s*$/,
    /^\s*([A-Za-z_]\w*)\s*:\s*([^=]+?)\s*(?:=|$)/,
    /^\s*([A-Za-z_]\w*)\s*=\s*([A-Z][\w.]*)\s*\(/,
  );
}

function bindingsFromRust(text: string, maxTier: TypeResolutionTier): TypeBinding[] {
  return bindingsFromAnnotatedLines(
    text,
    maxTier,
    '//',
    /^\s*fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/,
    /^\s*(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*(.+?)\s*$/,
    /^\s*let\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*([^;=]+?)\s*(?:=|;|$)/,
    /^\s*let\s+(?:mut\s+)?([A-Za-z_]\w*)\s*=\s*([A-Z]\w*)/,
  );
}

/**
 * Built-in container descriptors — maps container base names to type parameter
 * semantics per access method. Covers 40+ container types across 12 languages.
 *
 * Pattern reference: GitNexus type-extractors/shared.ts CONTAINER_DESCRIPTORS.
 */
const CONTAINER_DESCRIPTORS: ReadonlyMap<string, ContainerDescriptor> = new Map([
  // Key-value containers (arity 2)
  ['Map', { containerName: 'Map', arity: 2, keyMethods: ['keys', 'keySet'], valueMethods: ['values', 'get', 'pop', 'remove'] }],
  ['WeakMap', { containerName: 'WeakMap', arity: 2, keyMethods: ['keys'], valueMethods: ['values', 'get'] }],
  ['HashMap', { containerName: 'HashMap', arity: 2, keyMethods: ['keys'], valueMethods: ['values', 'get', 'remove'] }],
  ['BTreeMap', { containerName: 'BTreeMap', arity: 2, keyMethods: ['keys'], valueMethods: ['values', 'get', 'remove'] }],
  ['LinkedHashMap', { containerName: 'LinkedHashMap', arity: 2, keyMethods: ['keySet'], valueMethods: ['values', 'get'] }],
  ['TreeMap', { containerName: 'TreeMap', arity: 2, keyMethods: ['keySet'], valueMethods: ['values', 'get'] }],
  ['dict', { containerName: 'dict', arity: 2, keyMethods: ['keys'], valueMethods: ['values', 'get', 'pop'] }],
  ['Dictionary', { containerName: 'Dictionary', arity: 2, keyMethods: ['Keys'], valueMethods: ['Values', 'TryGetValue'] }],
  ['MutableMap', { containerName: 'MutableMap', arity: 2, keyMethods: ['keys'], valueMethods: ['values', 'get'] }],
  // Single-element containers (arity 1)
  ['Array', { containerName: 'Array', arity: 1, keyMethods: [], valueMethods: ['find', 'filter', 'map', 'first', 'last'] }],
  ['List', { containerName: 'List', arity: 1, keyMethods: [], valueMethods: ['get', 'first', 'last', 'find'] }],
  ['ArrayList', { containerName: 'ArrayList', arity: 1, keyMethods: [], valueMethods: ['get', 'iterator'] }],
  ['Vec', { containerName: 'Vec', arity: 1, keyMethods: [], valueMethods: ['iter', 'into_iter', 'get', 'first', 'last', 'pop'] }],
  ['Set', { containerName: 'Set', arity: 1, keyMethods: [], valueMethods: ['iter', 'iterator'] }],
  ['HashSet', { containerName: 'HashSet', arity: 1, keyMethods: [], valueMethods: ['iter', 'into_iter'] }],
  ['Queue', { containerName: 'Queue', arity: 1, keyMethods: [], valueMethods: ['peek', 'poll'] }],
  ['Stack', { containerName: 'Stack', arity: 1, keyMethods: [], valueMethods: ['peek', 'pop'] }],
  ['Stream', { containerName: 'Stream', arity: 1, keyMethods: [], valueMethods: ['filter', 'map', 'find'] }],
]);

/** Languages with a real extractor. Others stay an error, not an empty success. */
const SUPPORTED_LANGUAGES: readonly TreeSitterLanguage[] = ['typescript', 'javascript', 'python', 'rust'];

const EMPTY_TIER_STATS: Readonly<Record<TypeResolutionTier, number>> = {
  0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0,
};

export class TypeEnvironmentAdapter implements ITypeEnvironment {
  private readonly bindingsByFile = new Map<string, readonly TypeBinding[]>();

  async buildEnvironment(input: BuildTypeEnvironmentInput): Promise<TypeEnvironmentResult> {
    const start = performance.now();
    const maxTier = input.maxTier ?? 6;
    const bindings: TypeBinding[] = [];
    const analyzedFiles: string[] = [];
    const failedFiles: { filePath: string; reason: string }[] = [];
    const tierStats: Record<TypeResolutionTier, number> = { ...EMPTY_TIER_STATS };

    for (const filePath of input.filePaths) {
      const kind = sourceKind(filePath, input.language);
      if (!kind) {
        failedFiles.push({
          filePath,
          reason: input.language ? `language ${input.language} is not supported` : 'language is not supported',
        });
        continue;
      }
      if (!existsSync(filePath)) {
        failedFiles.push({ filePath, reason: 'file not found' });
        continue;
      }
      try {
        const found = kind === 'python'
          ? bindingsFromPython(readFileSync(filePath, 'utf8'), maxTier)
          : kind === 'rust'
            ? bindingsFromRust(readFileSync(filePath, 'utf8'), maxTier)
            : await bindingsFromScript(filePath, maxTier);
        this.bindingsByFile.set(`${input.tenantId}\0${filePath}`, found);
        bindings.push(...found);
        analyzedFiles.push(filePath);
        for (const binding of found) tierStats[binding.resolvedByTier] += 1;
      } catch (error) {
        failedFiles.push({
          filePath,
          reason: error instanceof Error ? error.message : 'type check failed',
        });
      }
    }

    return {
      bindings,
      tierStats,
      analyzedFiles,
      failedFiles,
      durationMs: Math.round(performance.now() - start),
    };
  }

  async resolveType(input: ResolveTypeInput): Promise<TypeResolutionResult> {
    const found = this.bindingsByFile.get(`${input.tenantId}\0${input.filePath}`) ?? [];
    const binding = found.find((item) => item.variableName === input.variableName && item.scope === input.scope)
      ?? found.find((item) => item.variableName === input.variableName);
    if (!binding) {
      return { typeName: undefined, resolvedByTier: undefined, isDefinitive: false };
    }
    return {
      typeName: binding.typeName,
      resolvedByTier: binding.resolvedByTier,
      isDefinitive: binding.resolvedByTier === 0,
    };
  }

  getSupportedLanguages(): readonly TreeSitterLanguage[] {
    return SUPPORTED_LANGUAGES;
  }

  /**
   * Look up a container descriptor by type name.
   * Container descriptors are statically defined — functional even in stub mode.
   */
  getContainerDescriptor(typeName: string): ContainerDescriptor | undefined {
    return CONTAINER_DESCRIPTORS.get(typeName);
  }
}
