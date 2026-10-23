/**
 * Domain port: Tree-sitter AST Parser.
 *
 * Provides language-agnostic AST parsing via tree-sitter for code intelligence.
 * Replaces regex-based symbol extraction with precise, incremental AST parsing
 * that supports 100+ programming languages through grammar modules.
 *
 * Architecture rationale:
 * - Domain port defines the contract (what we need)
 * - Infrastructure adapter handles tree-sitter WASM/native binding (how it works)
 * - Incremental parsing critical for real-time code intelligence (O(log n) edits)
 *
 * Academic foundation:
 * - Tree-sitter: Brunsfeld (2018) — incremental parsing framework, GLR algorithm
 * - Abstract Syntax Trees in code intelligence: Neamtiu et al. (2005)
 * - GitHub Code Navigation — tree-sitter-based symbol extraction (2019)
 * - Zed editor, Neovim, Helix — production tree-sitter integrations
 *
 * Competitor analysis (March 2026):
 * - GitHub Copilot: tree-sitter for prompt context extraction
 * - Sourcegraph: SCIP (Source Code Intelligence Protocol) + tree-sitter
 * - CodeQL: custom AST extraction → QL database
 * - Semgrep: tree-sitter-based pattern matching for security
 * - Cursor: tree-sitter for file outline + smart selection
 *
 * @module domain/memory/ITreeSitterParser
 * Layer: Domain
 * DI Token: DI_TOKENS.ITreeSitterParser
 */

import type { CorrelationId, TenantId } from '@/core/types/branded';

/** Languages supported by Tree-sitter with available grammar modules. */
export type TreeSitterLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'scala'
  | 'ruby'
  | 'elixir'
  | 'cpp'
  | 'c'
  | 'csharp';

/** AST node type classification for code intelligence. */
export type AstNodeKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'module'
  | 'import'
  | 'export'
  | 'variable'
  | 'type_alias'
  | 'call_expression'
  | 'parameter'
  | 'return_type';

/** Position in source code. */
export interface AstPosition {
  readonly row: number;
  readonly column: number;
}

/** Range in source code. */
export interface AstRange {
  readonly start: AstPosition;
  readonly end: AstPosition;
}

/** Extracted AST node with code intelligence metadata. */
export interface AstSymbol {
  /** Symbol name (e.g., function name, class name). */
  readonly name: string;
  /** Classification of the AST node. */
  readonly kind: AstNodeKind;
  /** Source range for navigation. */
  readonly range: AstRange;
  /** Parent symbol name (e.g., class for a method). */
  readonly parentName: string | null;
  /** Exported from module? */
  readonly isExported: boolean;
  /** Detected language. */
  readonly language: TreeSitterLanguage;
  /** Raw node type from tree-sitter (for debugging). */
  readonly treeSitterNodeType: string;
}

/** Call site extracted from AST — used for static call graph construction. */
export interface AstCallSite {
  /** Caller symbol (function/method making the call). */
  readonly callerName: string;
  /** Callee symbol (function/method being called). */
  readonly calleeName: string;
  /** Source range of the call expression. */
  readonly range: AstRange;
  /** Whether the call is to an imported symbol. */
  readonly isExternalCall: boolean;
}

/** Result of parsing a single file. */
export interface AstParseResult {
  /** File path that was parsed. */
  readonly filePath: string;
  /** Detected language. */
  readonly language: TreeSitterLanguage;
  /** Extracted symbols (functions, classes, etc.). */
  readonly symbols: readonly AstSymbol[];
  /** Extracted call sites (for static call graph). */
  readonly callSites: readonly AstCallSite[];
  /** Import statements found. */
  readonly imports: readonly string[];
  /** Parse errors (tree-sitter ERROR/MISSING nodes). */
  readonly errors: readonly { message: string; range: AstRange }[];
  /** Parse duration in ms. */
  readonly durationMs: number;
}

/** Input for file parsing. */
export interface ParseFileInput {
  /** File path to parse. */
  readonly filePath: string;
  /** File content (avoids re-reading from disk). */
  readonly content: string;
  /** Language hint (auto-detected from extension if not provided). */
  readonly language?: TreeSitterLanguage;
  /** Tenant ID for multi-tenant isolation. */
  readonly tenantId: TenantId;
  /** Correlation ID for tracing. */
  readonly correlationId: CorrelationId;
}

/**
 * ITreeSitterParser — domain port for AST-based code parsing.
 *
 * Provides incremental, language-agnostic AST parsing for code intelligence.
 * Replaces regex-based symbol extraction with precise tree-sitter parsing.
 */
export interface ITreeSitterParser {
  /**
   * Parse a file and extract symbols + call sites.
   *
   * @param input - File content and metadata
   * @returns Parsed AST with symbols, call sites, imports, and errors
   */
  parseFile(input: ParseFileInput): Promise<AstParseResult>;

  /**
   * Check if a language is supported by the current tree-sitter grammar set.
   *
   * @param language - Language to check
   * @returns true if grammar is loaded and available
   */
  isLanguageSupported(language: TreeSitterLanguage): boolean;

  /**
   * Get list of currently loaded language grammars.
   *
   * @returns Array of supported language identifiers
   */
  getSupportedLanguages(): readonly TreeSitterLanguage[];
}
