/**
 * ICodePathContextResolver — Domain port for deterministic code-path context retrieval.
 *
 * Resolves local enclosing symbol context for a cursor line and augments it with
 * related imported code snippets from the code knowledge graph.
 *
 * Layer: Domain
 */

import type { CorrelationId, TenantId } from '@/core/types/branded';

export type CodePathContextSnippetSource = 'local-symbol' | 'imported-graph';

export interface CodePathContextRequest {
  readonly tenantId: TenantId;
  readonly correlationId: CorrelationId;
  readonly filePath: string;
  readonly content: string;
  readonly line: number;
  readonly ignoredFilePaths?: readonly string[];
  readonly maxImportedSnippets?: number;
  readonly maxSnippets?: number;
}

export interface CodePathContextSnippet {
  readonly filePath: string;
  readonly content: string;
  readonly source: CodePathContextSnippetSource;
  readonly symbolName?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface CodePathContextResult {
  readonly snippets: readonly CodePathContextSnippet[];
  readonly cacheKey: string;
  readonly cacheHit: boolean;
}

export interface ICodePathContextResolver {
  resolve(input: CodePathContextRequest): Promise<CodePathContextResult>;
  invalidate(filePath?: string): void;
}