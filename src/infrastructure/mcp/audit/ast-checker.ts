/**
 * AST Checker — ts-morph based AST analysis for MCP Audit Server.
 *
 * Provides four analysis capabilities:
 *   1. Import dependency graph (who imports this file, what does it import)
 *   2. DI token impact analysis (which services depend on a token)
 *   3. Clean Architecture layer violation detection via AST (not regex)
 *   4. MCP runtime lessons contract validation (risk-aware tool semantics)
 *
 * Uses ts-morph for real TypeScript AST parsing — more accurate than regex.
 * Project instance is lazily initialized and cached for performance.
 *
 * Security: All file paths validated against src/ boundary (path traversal prevention).
 *
 * @layer Infrastructure (dev-time MCP tool)
 * @see MicroPhoenixAuditMcpServer.ts — consumer
 * @see ts-morph v27 — AST manipulation library
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph';
import { mcpLog as log, LAYER_DEPS as SHARED_LAYER_DEPS, detectLayer as sharedDetectLayer } from '../shared/mcp-utils';

// ── Types ─────────────────────────────────────────────────────────

export interface ImportEdge {
  /** Source file (importer). */
  readonly from: string;
  /** Target module specifier. */
  readonly to: string;
  /** Imported symbols (named imports). */
  readonly symbols: readonly string[];
  /** Line number of the import statement. */
  readonly line: number;
  /** Whether this is a type-only import. */
  readonly typeOnly: boolean;
}

export interface ImportGraphResult {
  /** The queried file path. */
  readonly file: string;
  /** Outgoing imports (this file imports from...). */
  readonly imports: readonly ImportEdge[];
  /** Incoming imports (files that import this file). */
  readonly importedBy: readonly ImportEdge[];
  /** Total files in the project. */
  readonly totalProjectFiles: number;
}

export interface DITokenUsage {
  /** File where the token is used. */
  readonly file: string;
  /** Line number. */
  readonly line: number;
  /** Usage context: 'resolve' | 'register' | 'reference'. */
  readonly kind: 'resolve' | 'register' | 'reference';
  /** Surrounding code snippet. */
  readonly snippet: string;
}

export interface DITokenImpactResult {
  /** The queried DI token. */
  readonly token: string;
  /** Files that resolve (consume) this token. */
  readonly consumers: readonly DITokenUsage[];
  /** Files that register (provide) this token. */
  readonly providers: readonly DITokenUsage[];
  /** All references. */
  readonly allReferences: readonly DITokenUsage[];
  /** Risk assessment if this token is removed. */
  readonly removalImpact: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface ASTLayerViolation {
  /** File with the violation. */
  readonly file: string;
  /** Line number of the violating import. */
  readonly line: number;
  /** The import module specifier. */
  readonly importPath: string;
  /** Layer of the importing file. */
  readonly fromLayer: string;
  /** Layer of the imported module. */
  readonly toLayer: string;
  /** Human-readable rule description. */
  readonly rule: string;
  /** Imported symbols (for targeted fix guidance). */
  readonly importedSymbols: readonly string[];
}

export interface ASTLayerCheckResult {
  /** The checked file. */
  readonly file: string;
  /** Detected layer. */
  readonly layer: string;
  /** Violations found. */
  readonly violations: readonly ASTLayerViolation[];
  /** Total import statements analyzed. */
  readonly importsAnalyzed: number;
  /** Clean status. */
  readonly status: 'clean' | 'violations_found';
}

export interface RuntimeErrorToolContractResult {
  /** The checked file. */
  readonly file: string;
  /** MCP tool whose contract is being validated. */
  readonly tool: 'view_runtime_error_lessons';
  /** Contract violations detected via AST. */
  readonly issues: readonly string[];
  /** Validation status. */
  readonly status: 'ok' | 'violations_found';
}

// ── Project Cache ─────────────────────────────────────────────────

// FIX: AUD-AST-001 — Use SSOT from shared/mcp-utils instead of local duplicate.
const LAYER_DEPS = SHARED_LAYER_DEPS;

let cachedProject: Project | null = null;
let cachedProjectRoot: string | null = null;

/**
 * Get or create a ts-morph Project instance.
 * Lazily loaded and cached — first call takes ~2-5s for large projects.
 */
function getProject(projectRoot: string): Project {
  if (cachedProject && cachedProjectRoot === projectRoot) {
    return cachedProject;
  }

  const t0 = Date.now();
  const tsConfigPath = path.join(projectRoot, 'tsconfig.json');

  cachedProject = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: false,
    skipFileDependencyResolution: false,
  });

  cachedProjectRoot = projectRoot;
  const fileCount = cachedProject.getSourceFiles().length;
  log('mcp.ast.project.loaded', { files: fileCount, durationMs: Date.now() - t0 });

  return cachedProject;
}

// FIX: AUD-AST-001 — Use SSOT detectLayer from shared/mcp-utils instead of local duplicate.
const detectLayer = sharedDetectLayer;

/**
 * Get workspace-relative path from a source file.
 */
function relativePath(sourceFile: SourceFile, projectRoot: string): string {
  return path.relative(projectRoot, sourceFile.getFilePath()).replace(/\\/g, '/');
}

/**
 * Extract import edges from a single source file.
 */
function extractImports(sourceFile: SourceFile, projectRoot: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const imports = sourceFile.getImportDeclarations();

  for (const imp of imports) {
    const moduleSpecifier = imp.getModuleSpecifierValue();
    const namedImports = imp.getNamedImports().map((n) => n.getName());
    const defaultImport = imp.getDefaultImport()?.getText();
    const namespaceImport = imp.getNamespaceImport()?.getText();

    const symbols: string[] = [...namedImports];
    if (defaultImport) symbols.push(defaultImport);
    if (namespaceImport) symbols.push(`* as ${namespaceImport}`);

    edges.push({
      from: relativePath(sourceFile, projectRoot),
      to: moduleSpecifier,
      symbols,
      line: imp.getStartLineNumber(),
      typeOnly: imp.isTypeOnly(),
    });
  }

  return edges;
}

function getNestedObjectLiteralPropertyText(
  node: { getProperty?: (name: string) => unknown },
  name: string,
): string | undefined {
  const property = node.getProperty?.(name) as { getInitializer?: () => { getText?: () => string } | undefined } | undefined;
  return property?.getInitializer?.()?.getText?.();
}

function collectRuntimeErrorToolContractIssues(sourceFile: SourceFile): string[] {
  const issues: string[] = [];

  const functionNames = new Set(
    sourceFile.getFunctions().map((fn) => fn.getName()).filter(Boolean),
  );
  if (!functionNames.has('calculateRuntimeErrorLessonRiskScore')) {
    issues.push('Missing calculateRuntimeErrorLessonRiskScore function');
  }
  if (!functionNames.has('calculateRuntimeErrorRollupRiskScore')) {
    issues.push('Missing calculateRuntimeErrorRollupRiskScore function');
  }
  if (!functionNames.has('getSeverityRank')) {
    issues.push('Missing getSeverityRank function (risk scoring dependency)');
  }

  const helperFn = sourceFile.getFunction('registerRuntimeErrorLessonsTool');
  const registerCall = helperFn
    ?.getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((call) => {
      const expressionText = call.getExpression().getText();
      const args = call.getArguments();
      if (expressionText.endsWith('.registerTool')) {
        return args[0]?.getText() === "'view_runtime_error_lessons'";
      }
      return expressionText === 'registerContextTool'
        && args[1]?.getText() === "'view_runtime_error_lessons'";
    });

  if (!registerCall) {
    issues.push('Could not locate view_runtime_error_lessons tool block');
    return issues;
  }

  const registerArgs = registerCall.getArguments();
  const throughAdapter = registerCall.getExpression().getText() === 'registerContextTool';
  const configArg = registerArgs[throughAdapter ? 2 : 1];
  if (!configArg || !Node.isObjectLiteralExpression(configArg)) {
    issues.push('Could not locate view_runtime_error_lessons tool block');
    return issues;
  }

  const inputSchemaText = getNestedObjectLiteralPropertyText(configArg, 'inputSchema') ?? '';
  const outputSchemaText = getNestedObjectLiteralPropertyText(configArg, 'outputSchema') ?? '';

  if (!/sort_by:\s*z\.enum\(\['lessons', 'recurrence', 'severity', 'risk'\]\)/.test(inputSchemaText)) {
    issues.push('Missing sort_by risk enum value in view_runtime_error_lessons schema');
  }
  if (!/file_rollups:[\s\S]*?riskScore:\s*z\.number\(\)/.test(outputSchemaText)) {
    issues.push('Missing file_rollups riskScore in view_runtime_error_lessons outputSchema');
  }
  if (!/subsystem_rollups:[\s\S]*?riskScore:\s*z\.number\(\)/.test(outputSchemaText)) {
    issues.push('Missing subsystem_rollups riskScore in view_runtime_error_lessons outputSchema');
  }
  if (!/lessons:[\s\S]*?riskScore:\s*z\.number\(\)\.optional\(\)/.test(outputSchemaText)) {
    issues.push('Missing lesson riskScore in view_runtime_error_lessons outputSchema');
  }

  const handlerArg = registerArgs[throughAdapter ? 3 : 2];
  const handlerText = handlerArg?.getText() ?? '';
  const helperHandlerWiring =
    /buildRuntimeErrorLessonsToolResult\(/.test(handlerText) &&
    /options\.projectRoot/.test(handlerText) &&
    /options\.loaderDeps\s*\?\?\s*\{\}/.test(handlerText) &&
    /options\.knownBugsEntries\s*\?\?\s*\[\]/.test(handlerText);
  if (!helperHandlerWiring) {
    issues.push('Tool handler is not wired to buildRuntimeErrorLessonsToolResult with knownBugsEntries');
  }

  const mainRegistrationOk = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((call) => {
      if (call.getExpression().getText() !== 'registerRuntimeErrorLessonsTool') return false;
      const args = call.getArguments();
      if (args.length < 2) return false;
      const config = args[1];
      if (!Node.isObjectLiteralExpression(config)) return false;
      const projectRootProp = config.getProperty('projectRoot');
      const knownBugsProp = config.getProperty('knownBugsEntries');
      return projectRootProp?.getText().includes('PROJECT_ROOT') === true
        && knownBugsProp?.getText().includes('knownBugsEntries') === true;
    });

  if (!mainRegistrationOk) {
    issues.push('Main MCP bootstrap does not register view_runtime_error_lessons via registerRuntimeErrorLessonsTool');
  }

  return issues;
}
// ── Public API ────────────────────────────────────────────────────

/**
 * Analyze import dependency graph for a specific file.
 * Returns both outgoing imports and incoming references (who imports this file).
 */
export function analyzeImportGraph(projectRoot: string, filePath: string): ImportGraphResult {
  const project = getProject(projectRoot);
  const absPath = path.resolve(projectRoot, filePath);

  const sourceFile = project.getSourceFile(absPath);
  if (!sourceFile) {
    return {
      file: filePath,
      imports: [],
      importedBy: [],
      totalProjectFiles: project.getSourceFiles().length,
    };
  }

  // Outgoing imports
  const imports = extractImports(sourceFile, projectRoot);

  // Incoming imports — find all files that import this file
  const importedBy: ImportEdge[] = [];
  const referencingFiles = sourceFile.getReferencingSourceFiles();

  for (const refFile of referencingFiles) {
    const refImports = refFile.getImportDeclarations();
    for (const imp of refImports) {
      const resolved = imp.getModuleSpecifierSourceFile();
      if (resolved && resolved.getFilePath() === sourceFile.getFilePath()) {
        const namedImports = imp.getNamedImports().map((n) => n.getName());
        const defaultImport = imp.getDefaultImport()?.getText();
        const symbols: string[] = [...namedImports];
        if (defaultImport) symbols.push(defaultImport);

        importedBy.push({
          from: relativePath(refFile, projectRoot),
          to: filePath,
          symbols,
          line: imp.getStartLineNumber(),
          typeOnly: imp.isTypeOnly(),
        });
      }
    }
  }

  return {
    file: filePath,
    imports,
    importedBy,
    totalProjectFiles: project.getSourceFiles().length,
  };
}

/**
 * Analyze DI token impact — find all consumers and providers for a token.
 */
export function analyzeDITokenImpact(projectRoot: string, tokenName: string): DITokenImpactResult {
  const project = getProject(projectRoot);
  const consumers: DITokenUsage[] = [];
  const providers: DITokenUsage[] = [];
  const allReferences: DITokenUsage[] = [];

  // Search patterns for DI token usage
  // Escape tokenName to prevent regex injection (CWE-1333)
  const escaped = tokenName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const resolvePattern = new RegExp(`\\.resolve[<(].*?['"]${escaped}['"]`, 'g');
  const registerPattern = new RegExp(`\\.register[<(].*?['"]${escaped}['"]`, 'g');
  const tokenRefPattern = new RegExp(`DI_TOKENS\\.${escaped}\\b`, 'g');

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = relativePath(sourceFile, projectRoot);
    // Skip node_modules and test files for performance
    if (filePath.includes('node_modules/')) continue;

    const text = sourceFile.getFullText();
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const snippet = line.trim().slice(0, 120);

      if (resolvePattern.test(line)) {
        consumers.push({ file: filePath, line: lineNum, kind: 'resolve', snippet });
      }
      resolvePattern.lastIndex = 0;

      if (registerPattern.test(line)) {
        providers.push({ file: filePath, line: lineNum, kind: 'register', snippet });
      }
      registerPattern.lastIndex = 0;

      if (tokenRefPattern.test(line)) {
        allReferences.push({ file: filePath, line: lineNum, kind: 'reference', snippet });
      }
      tokenRefPattern.lastIndex = 0;
    }
  }

  // Calculate removal impact
  const totalConsumers = consumers.length;
  let removalImpact: DITokenImpactResult['removalImpact'];
  if (totalConsumers === 0) removalImpact = 'NONE';
  else if (totalConsumers <= 2) removalImpact = 'LOW';
  else if (totalConsumers <= 5) removalImpact = 'MEDIUM';
  else if (totalConsumers <= 15) removalImpact = 'HIGH';
  else removalImpact = 'CRITICAL';

  return {
    token: tokenName,
    consumers,
    providers,
    allReferences,
    removalImpact,
  };
}

/**
 * Check a file for Clean Architecture layer violations using AST.
 * More accurate than regex — resolves module specifiers to actual files.
 */
export function checkLayerViolationsAST(projectRoot: string, filePath: string, projectOverride?: Project): ASTLayerCheckResult {
  const project = projectOverride ?? getProject(projectRoot);
  const absPath = path.resolve(projectRoot, filePath);

  const sourceFile = project.getSourceFile(absPath);
  if (!sourceFile) {
    return {
      file: filePath,
      layer: 'unknown',
      violations: [],
      importsAnalyzed: 0,
      status: 'clean',
    };
  }

  const fromLayer = detectLayer(filePath);
  if (fromLayer === 'unknown' || fromLayer === 'tests') {
    return {
      file: filePath,
      layer: fromLayer,
      violations: [],
      importsAnalyzed: 0,
      status: 'clean',
    };
  }

  const allowedDeps = LAYER_DEPS[fromLayer] ?? [];
  const violations: ASTLayerViolation[] = [];
  const imports = sourceFile.getImportDeclarations();

  for (const imp of imports) {
    const moduleSpecifier = imp.getModuleSpecifierValue();

    // Only check internal imports
    if (!moduleSpecifier.startsWith('@/') && !moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('src/')) {
      continue;
    }

    // Try to resolve the import to a real file
    const resolved = imp.getModuleSpecifierSourceFile();
    let targetLayer: string;

    if (resolved) {
      const resolvedPath = relativePath(resolved, projectRoot);
      targetLayer = detectLayer(resolvedPath);
    } else {
      // Fallback: infer from module specifier
      let resolvedImport = moduleSpecifier;
      if (moduleSpecifier.startsWith('@/')) {
        resolvedImport = 'src/' + moduleSpecifier.slice(2);
      }
      targetLayer = detectLayer(resolvedImport);
    }

    if (targetLayer === 'unknown' || targetLayer === 'tests' || targetLayer === fromLayer) {
      continue;
    }

    if (!allowedDeps.includes(targetLayer)) {
      const namedImports = imp.getNamedImports().map((n) => n.getName());
      violations.push({
        file: filePath,
        line: imp.getStartLineNumber(),
        importPath: moduleSpecifier,
        fromLayer,
        toLayer: targetLayer,
        rule: `${fromLayer} → ${targetLayer} is forbidden. Allowed: ${allowedDeps.join(', ') || 'none'}`,
        importedSymbols: namedImports,
      });
    }
  }

  return {
    file: filePath,
    layer: fromLayer,
    violations,
    importsAnalyzed: imports.length,
    status: violations.length === 0 ? 'clean' : 'violations_found',
  };
}

/**
 * Validate the runtime lessons MCP tool contract using real AST structure.
 */
export function readContextMcpContractSource(serverFilePath: string): string {
  const parts = [fs.readFileSync(serverFilePath, 'utf8')];
  const toolsDir = path.join(path.dirname(serverFilePath), 'tools');
  if (fs.existsSync(toolsDir)) {
    for (const name of fs.readdirSync(toolsDir).filter((entry) => entry.endsWith('.ts')).sort()) {
      parts.push(fs.readFileSync(path.join(toolsDir, name), 'utf8'));
    }
  }
  return parts.join('\n');
}

export function validateRuntimeErrorLessonsToolContractAst(
  projectRoot: string,
  filePath: string,
  projectOverride?: Project,
): RuntimeErrorToolContractResult {
  const absPath = path.resolve(projectRoot, filePath);
  if (absPath.endsWith(`${path.sep}MicroPhoenixMcpServer.ts`)) {
    const issues = validateRuntimeErrorLessonsToolContractAstSource(readContextMcpContractSource(absPath));
    return {
      file: filePath,
      tool: 'view_runtime_error_lessons',
      issues,
      status: issues.length === 0 ? 'ok' : 'violations_found',
    };
  }
  const project = projectOverride ?? getProject(projectRoot);

  let sourceFile = project.getSourceFile(absPath);
  if (!sourceFile) {
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      const fallbackProject = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
      sourceFile = fallbackProject.createSourceFile(absPath, content, { overwrite: true });
    } catch {
      sourceFile = undefined;
    }
  }

  const issues = sourceFile
    ? collectRuntimeErrorToolContractIssues(sourceFile)
    : ['Could not locate view_runtime_error_lessons tool block'];

  return {
    file: filePath,
    tool: 'view_runtime_error_lessons',
    issues,
    status: issues.length === 0 ? 'ok' : 'violations_found',
  };
}

/**
 * Validate the runtime lessons MCP tool contract from raw source text.
 * Used by focused fixture tests to keep regressions cheap to reproduce.
 */
export function validateRuntimeErrorLessonsToolContractAstSource(content: string): string[] {
  const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
  const sourceFile = project.createSourceFile('MicroPhoenixMcpServer.ts', content, { overwrite: true });
  return collectRuntimeErrorToolContractIssues(sourceFile);
}

/**
 * Invalidate the cached ts-morph project (e.g., after file modifications).
 */
export function invalidateProjectCache(): void {
  cachedProject = null;
  cachedProjectRoot = null;
  log('mcp.ast.cache.invalidated', {});
}
