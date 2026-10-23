/**
 * Domain port: Type Environment for Code Intelligence.
 *
 * Provides scope-aware type resolution for variables/parameters across
 * multiple programming languages. Enables type-aware code graph edges
 * (HAS_METHOD, OVERRIDES) and chained call resolution without executing code.
 *
 * Architecture rationale:
 * - Domain port defines the contract (type resolution capabilities)
 * - Infrastructure adapter handles AST-based type extraction (via ITreeSitterParser)
 * - 7-tier progressive resolution: each tier builds on previous results
 * - Language-agnostic core with language-specific extractors
 *
 * Resolution tiers (inspired by GitNexus v1.4.6 type-env pattern):
 * - Tier 0: Explicit type annotations (e.g., `let x: string`)
 * - Tier 1: Constructor inference (e.g., `const x = new Foo()`)
 * - Tier 2: Assignment chain propagation (e.g., `const b = a` → copy type)
 * - Tier 3: Self/this/super resolution (class context-aware lookup)
 * - Tier 4: Nullable unwrap + for-loop variable inference
 * - Tier 5: Chained call resolution (e.g., `map.get("k")` → value type)
 * - Tier 6: Container descriptor resolution (Map, List, Vec, etc.)
 *
 * Academic foundation:
 * - Hindley-Milner type inference: Milner (1978) — foundational algorithm W
 * - Flow-sensitive typing: Pearce & Groves (2013) — scope-aware narrowing
 * - Gradual typing: Siek & Taha (2006) — mixing typed/untyped code
 * - Tree-sitter incremental parsing: Brunsfeld (2018) — GLR AST framework
 *
 * Competitor analysis (March 2026):
 * - TypeScript Language Service: full Hindley-Milner + control flow analysis
 * - Pyright/Pylance: flow-sensitive type narrowing for Python
 * - rust-analyzer: Chalk-based trait resolution + type inference
 * - GitNexus: 7-tier progressive resolution, 12 languages, container descriptors
 * - Sourcegraph SCIP: cross-repo type-aware navigation
 *
 * @module domain/memory/ITypeEnvironment
 * Layer: Domain
 * DI Token: DI_TOKENS.ITypeEnvironment
 */

import type { CorrelationId, TenantId } from '@/core/types/branded';
import type { TreeSitterLanguage } from './ITreeSitterParser';

// ---------------------------------------------------------------------------
// Resolution tier classification
// ---------------------------------------------------------------------------

/**
 * Progressive type resolution tier.
 * Each tier builds on results from lower tiers. Higher tiers are more expensive
 * but resolve more complex patterns.
 */
export type TypeResolutionTier = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Human-readable names for each resolution tier. */
export const TYPE_RESOLUTION_TIER_NAMES: Record<TypeResolutionTier, string> = {
  0: 'annotation',
  1: 'constructor',
  2: 'assignment-chain',
  3: 'self-this-super',
  4: 'nullable-unwrap-loop',
  5: 'chained-call',
  6: 'container-descriptor',
} as const;

// ---------------------------------------------------------------------------
// Type binding — a resolved variable → type mapping
// ---------------------------------------------------------------------------

/** A resolved type binding for a variable within a scope. */
export interface TypeBinding {
  /** Variable name as it appears in source code. */
  readonly variableName: string;
  /** Resolved type name (e.g., 'User', 'string', 'Map<string, User>'). */
  readonly typeName: string;
  /** Scope in which this binding is valid (e.g., 'processOrder@42'). */
  readonly scope: string;
  /** Which resolution tier produced this binding. */
  readonly resolvedByTier: TypeResolutionTier;
}

// ---------------------------------------------------------------------------
// Container descriptors — generic type parameter semantics
// ---------------------------------------------------------------------------

/** Describes type parameter semantics for a container type. */
export interface ContainerDescriptor {
  /** Container base name (e.g., 'Map', 'Vec', 'HashMap'). */
  readonly containerName: string;
  /** Number of type parameters (1 = single-element, 2 = key-value). */
  readonly arity: 1 | 2;
  /** Method names that yield the key/first type parameter. */
  readonly keyMethods: readonly string[];
  /** Method names that yield the value/last type parameter. */
  readonly valueMethods: readonly string[];
}

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/** Input for building a type environment from source file(s). */
export interface BuildTypeEnvironmentInput {
  /** Tenant isolation context. */
  readonly tenantId: TenantId;
  /** Correlation ID for distributed tracing. */
  readonly correlationId: CorrelationId;
  /** File path(s) to analyze. */
  readonly filePaths: readonly string[];
  /** Programming language (auto-detected from extension if omitted). */
  readonly language?: TreeSitterLanguage;
  /** Maximum resolution tier to apply (default: 6 = all tiers). */
  readonly maxTier?: TypeResolutionTier;
}

/** Input for resolving a specific variable's type. */
export interface ResolveTypeInput {
  /** Tenant isolation context. */
  readonly tenantId: TenantId;
  /** Correlation ID for distributed tracing. */
  readonly correlationId: CorrelationId;
  /** Variable name to resolve. */
  readonly variableName: string;
  /** Scope key (e.g., 'functionName@lineNumber'). */
  readonly scope: string;
  /** File path where the variable appears. */
  readonly filePath: string;
}

/** Result of building a type environment. */
export interface TypeEnvironmentResult {
  /** All resolved type bindings across analyzed files. */
  readonly bindings: readonly TypeBinding[];
  /** Per-tier statistics: how many bindings each tier resolved. */
  readonly tierStats: Readonly<Record<TypeResolutionTier, number>>;
  /** Files that were successfully analyzed. */
  readonly analyzedFiles: readonly string[];
  /** Files that failed analysis (with reason). */
  readonly failedFiles: readonly { filePath: string; reason: string }[];
  /** Total processing duration in milliseconds. */
  readonly durationMs: number;
}

/** Result of resolving a single variable's type. */
export interface TypeResolutionResult {
  /** Resolved type name, or undefined if unresolvable. */
  readonly typeName: string | undefined;
  /** Which tier resolved the type (undefined if not resolved). */
  readonly resolvedByTier: TypeResolutionTier | undefined;
  /** Whether the resolution is definitive (true) or heuristic (false). */
  readonly isDefinitive: boolean;
}

// ---------------------------------------------------------------------------
// Domain port interface
// ---------------------------------------------------------------------------

/**
 * Type Environment port — scope-aware type resolution for code intelligence.
 *
 * Builds a type environment from source files using progressive resolution
 * (tiers 0-6), then supports point queries for individual variable types.
 *
 * Thread-safety: Implementations must be safe for concurrent calls
 * with different tenantId/correlationId pairs.
 */
export interface ITypeEnvironment {
  /**
   * Build a type environment from one or more source files.
   * Applies progressive resolution tiers (0 through maxTier).
   *
   * @param input - Files and resolution parameters
   * @returns Resolved bindings with per-tier statistics
   */
  buildEnvironment(input: BuildTypeEnvironmentInput): Promise<TypeEnvironmentResult>;

  /**
   * Resolve the type of a specific variable in a given scope.
   * Requires a prior `buildEnvironment()` call for the containing file.
   *
   * @param input - Variable name, scope, and file path
   * @returns Resolved type or undefined
   */
  resolveType(input: ResolveTypeInput): Promise<TypeResolutionResult>;

  /**
   * Get the list of languages supported for type resolution.
   * Subset of TreeSitterLanguage — not all AST-parseable languages
   * have type extractors implemented.
   */
  getSupportedLanguages(): readonly TreeSitterLanguage[];

  /**
   * Get the container descriptor for a given type name.
   * Used for resolving generic container element types
   * (e.g., Map<K,V>.values() → V).
   *
   * @param typeName - Container type name (e.g., 'Map', 'Vec', 'HashMap')
   * @returns Descriptor or undefined if not a known container
   */
  getContainerDescriptor(typeName: string): ContainerDescriptor | undefined;
}
