/**
 * Infrastructure adapter: AST Parser for code intelligence.
 *
 * Despite the historical name, this adapter now provides a working
 * TypeScript/JavaScript implementation using the TypeScript compiler API.
 * This keeps the current TypeScript-heavy MicroPhoenix repo on a real
 * AST-backed path without introducing a second donor runtime.
 *
 * For non-TS/JS languages, the adapter still degrades honestly and reports
 * unsupported-language diagnostics instead of simulating completeness.
 *
 * @see domain/memory/ITreeSitterParser.ts
 * Layer: Infrastructure
 */

import type {
  ITreeSitterParser,
  ParseFileInput,
  AstParseResult,
  TreeSitterLanguage,
  AstCallSite,
  AstNodeKind,
  AstRange,
  AstSymbol,
} from '../../../domain/memory/ITreeSitterParser';

type TsModule = typeof import('typescript');

const SUPPORTED_LANGUAGES = ['typescript', 'javascript'] as const satisfies readonly TreeSitterLanguage[];

let tsModulePromise: Promise<TsModule> | null = null;

async function loadTypeScript(): Promise<TsModule> {
  if (!tsModulePromise) {
    tsModulePromise = import('typescript').then((mod) => mod.default ?? mod);
  }
  return tsModulePromise;
}

function toRange(ts: TsModule, sourceFile: import('typescript').SourceFile, start: number, end: number): AstRange {
  const startPos = sourceFile.getLineAndCharacterOfPosition(start);
  const endPos = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    start: { row: startPos.line + 1, column: startPos.character + 1 },
    end: { row: endPos.line + 1, column: endPos.character + 1 },
  };
}

function detectScriptKind(filePath: string): TreeSitterLanguage {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return ['.js', '.jsx'].includes(ext) ? 'javascript' : 'typescript';
}

function isNodeExported(ts: TsModule, node: import('typescript').Node): boolean {
  return Boolean(ts.getCombinedModifierFlags(node as import('typescript').Declaration) & ts.ModifierFlags.Export);
}

function mapSymbolKind(kind: AstNodeKind): string {
  return kind;
}

function getPropertyAccessRoot(ts: TsModule, node: import('typescript').Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return getPropertyAccessRoot(ts, node.expression);
  if (ts.isCallExpression(node)) return getPropertyAccessRoot(ts, node.expression);
  return null;
}

function getCalleeName(ts: TsModule, expression: import('typescript').LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** File extension → tree-sitter language mapping. */
const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, TreeSitterLanguage> = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.py', 'python'],
  ['.rs', 'rust'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.scala', 'scala'],
  ['.sc', 'scala'],
  ['.rb', 'ruby'],
  ['.ex', 'elixir'],
  ['.exs', 'elixir'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cs', 'csharp'],
]);

export class TreeSitterParserAdapter implements ITreeSitterParser {
  async parseFile(input: ParseFileInput): Promise<AstParseResult> {
    const start = performance.now();
    const ext = input.filePath.substring(input.filePath.lastIndexOf('.'));
    const language = input.language ?? EXTENSION_TO_LANGUAGE.get(ext) ?? detectScriptKind(input.filePath);

    if (!this.isLanguageSupported(language)) {
      return {
        filePath: input.filePath,
        language,
        symbols: [],
        callSites: [],
        imports: [],
        errors: [{
          message: `Unsupported AST language: ${language}. Working AST support is currently implemented for TypeScript/JavaScript only.`,
          range: { start: { row: 1, column: 1 }, end: { row: 1, column: 1 } },
        }],
        durationMs: Math.round(performance.now() - start),
      };
    }

    const ts = await loadTypeScript();
    const scriptKind = language === 'javascript'
      ? (input.filePath.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS)
      : (input.filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const sourceFile = ts.createSourceFile(
      input.filePath,
      input.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    const symbols: AstSymbol[] = [];
    const callSites: AstCallSite[] = [];
    const imports: string[] = [];
    const errors: Array<{ message: string; range: AstRange }> = [];
    const importBindings = new Set<string>();
    const scopeStack: string[] = [];

    const diagnostics = (sourceFile as import('typescript').SourceFile & {
      parseDiagnostics?: readonly import('typescript').DiagnosticWithLocation[];
    }).parseDiagnostics ?? [];
    for (const diagnostic of diagnostics) {
      const startPos = diagnostic.start ?? 0;
      errors.push({
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        range: toRange(ts, sourceFile, startPos, startPos + (diagnostic.length ?? 0)),
      });
    }

    const currentScope = (): string | null => scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;

    const addSymbol = (
      node: import('typescript').Node,
      name: string,
      kind: AstNodeKind,
      rawNodeType: string,
    ): string => {
      const parentName = currentScope();
      symbols.push({
        name,
        kind: mapSymbolKind(kind) as AstNodeKind,
        range: toRange(ts, sourceFile, node.getStart(sourceFile), node.getEnd()),
        parentName,
        isExported: isNodeExported(ts, node),
        language,
        treeSitterNodeType: rawNodeType,
      });
      return parentName ? `${parentName}.${name}` : name;
    };

    const visit = (node: import('typescript').Node): void => {
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          imports.push(moduleSpecifier.text);
        }
        const clause = node.importClause;
        if (clause?.name) importBindings.add(clause.name.text);
        const namedBindings = clause?.namedBindings;
        if (namedBindings) {
          if (ts.isNamespaceImport(namedBindings)) {
            importBindings.add(namedBindings.name.text);
          } else {
            for (const element of namedBindings.elements) {
              importBindings.add((element.name ?? element.propertyName)?.text ?? element.getText(sourceFile));
            }
          }
        }
      }

      if (ts.isFunctionDeclaration(node) && node.name) {
        const fqName = addSymbol(node, node.name.text, 'function', 'FunctionDeclaration');
        scopeStack.push(fqName);
        ts.forEachChild(node, visit);
        scopeStack.pop();
        return;
      }

      if (ts.isClassDeclaration(node) && node.name) {
        const fqName = addSymbol(node, node.name.text, 'class', 'ClassDeclaration');
        scopeStack.push(fqName);
        ts.forEachChild(node, visit);
        scopeStack.pop();
        return;
      }

      if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        const fqName = addSymbol(node, node.name.text, 'method', 'MethodDeclaration');
        scopeStack.push(fqName);
        ts.forEachChild(node, visit);
        scopeStack.pop();
        return;
      }

      if (ts.isInterfaceDeclaration(node)) {
        const fqName = addSymbol(node, node.name.text, 'interface', 'InterfaceDeclaration');
        scopeStack.push(fqName);
        ts.forEachChild(node, visit);
        scopeStack.pop();
        return;
      }

      if (ts.isEnumDeclaration(node)) {
        addSymbol(node, node.name.text, 'enum', 'EnumDeclaration');
      }

      if (ts.isTypeAliasDeclaration(node)) {
        addSymbol(node, node.name.text, 'type_alias', 'TypeAliasDeclaration');
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && scopeStack.length === 0) {
        symbols.push({
          name: node.name.text,
          kind: 'variable',
          range: toRange(ts, sourceFile, node.getStart(sourceFile), node.getEnd()),
          parentName: null,
          isExported: isNodeExported(ts, node.parent?.parent ?? node),
          language,
          treeSitterNodeType: 'VariableDeclaration',
        });
      }

      if (ts.isCallExpression(node) && currentScope()) {
        const calleeName = getCalleeName(ts, node.expression);
        if (calleeName) {
          const rootIdentifier = getPropertyAccessRoot(ts, node.expression);
          callSites.push({
            callerName: currentScope()!,
            calleeName,
            range: toRange(ts, sourceFile, node.getStart(sourceFile), node.getEnd()),
            isExternalCall: rootIdentifier != null && importBindings.has(rootIdentifier),
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return {
      filePath: input.filePath,
      language,
      symbols,
      callSites,
      imports,
      errors,
      durationMs: Math.round(performance.now() - start),
    };
  }

  isLanguageSupported(language: TreeSitterLanguage): boolean {
    return SUPPORTED_LANGUAGES.includes(language as (typeof SUPPORTED_LANGUAGES)[number]);
  }

  getSupportedLanguages(): readonly TreeSitterLanguage[] {
    return [...SUPPORTED_LANGUAGES];
  }
}
