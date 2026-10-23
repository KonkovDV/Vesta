/**
 * IAgentComputerInterface — Domain port for Agent-Computer Interface (ACI).
 *
 * SOTA 2026 Extraction: Instead of giving LLM agents raw read_file/write_file tools,
 * ACI provides semantic IDE-like operations optimized for machine consumption:
 *   - AST-level navigation (not line numbers)
 *   - Sandboxed test execution (V8 isolate)
 *   - Diff-patch application (not full file rewrites)
 *
 * This reduces hallucination of file paths, prevents full-file overwrite errors,
 * and enables structured code manipulation at the syntax tree level.
 *
 * Academic References:
 *   - Yang et al. (2024) "SWE-agent: Agent-Computer Interfaces Enable Automated SE"
 *   - Wang et al. (2024) "OpenHands: An Open Platform for AI Software Developers"
 *   - Zhang et al. (2025) "Eco-Evolve: Co-Evolutionary Multi-Agent SE Framework"
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @horizon H1: ACI Integration
 * @see PLANS/docs/mcp_and_testing_audit/31-advanced-multi-agent-extraction.md — Idea 1
 * @see src/infrastructure/mcp/audit/ast-checker.ts — existing ts-morph AST analysis
 */

import type { CorrelationId } from '@/ai-types';

// ── AST Navigation ────────────────────────────────────────────────

/**
 * A node in the TypeScript AST identified by a semantic path.
 * Example: "src/core/di/DI_TOKENS.ts::DI_TOKENS.IEventStore"
 */
export interface ASTNodeReference {
  /** Relative file path from project root. */
  readonly filePath: string;
  /** Dot-separated AST path (e.g. "ClassName.methodName"). */
  readonly nodePath: string;
  /** Node kind (class, method, property, interface, function, type, variable). */
  readonly kind: ASTNodeKind;
  /** Start line (1-based). */
  readonly startLine: number;
  /** End line (1-based). */
  readonly endLine: number;
  /** The source text of the node. */
  readonly sourceText: string;
}

export type ASTNodeKind =
  | 'class'
  | 'method'
  | 'property'
  | 'interface'
  | 'function'
  | 'type'
  | 'variable'
  | 'enum'
  | 'import'
  | 'export'
  | 'unknown';

/** Result of AST navigation. */
export interface ASTNavigationResult {
  /** Whether the node was found. */
  readonly found: boolean;
  /** The resolved node (if found). */
  readonly node?: ASTNodeReference;
  /** Child nodes available for deeper navigation. */
  readonly children: readonly ASTNodeReference[];
  /** Suggestions if node not found (fuzzy match). */
  readonly suggestions: readonly string[];
}

// ── Sandbox Execution ─────────────────────────────────────────────

/**
 * Result of running a test in a sandboxed environment.
 */
export interface SandboxTestResult {
  /** Whether the test passed. */
  readonly passed: boolean;
  /** Exit code of the process. */
  readonly exitCode: number;
  /** Stdout output (truncated to maxOutputBytes). */
  readonly stdout: string;
  /** Stderr output (truncated to maxOutputBytes). */
  readonly stderr: string;
  /** Execution duration in milliseconds. */
  readonly durationMs: number;
  /** Unique isolate identifier. */
  readonly isolateId: string;
}

export interface SandboxTestOptions {
  /** Timeout in milliseconds (default: 30_000). */
  readonly timeoutMs?: number;
  /** Maximum output bytes per stream (default: 64KB). */
  readonly maxOutputBytes?: number;
  /** Environment variables to inject. */
  readonly env?: Readonly<Record<string, string>>;
  /** Whether to allow network access (default: false). */
  readonly allowNetwork?: boolean;
}

// ── Diff-Patch Application ────────────────────────────────────────

/**
 * Result of applying a unified diff patch.
 */
export interface DiffPatchResult {
  /** Whether the patch applied cleanly. */
  readonly applied: boolean;
  /** Number of hunks successfully applied. */
  readonly hunksApplied: number;
  /** Number of hunks that failed (fuzz/conflict). */
  readonly hunksFailed: number;
  /** Files modified by the patch. */
  readonly filesModified: readonly string[];
  /** Rejection details if any hunks failed. */
  readonly rejections: readonly PatchRejection[];
}

export interface PatchRejection {
  /** File that had the rejection. */
  readonly file: string;
  /** Hunk index (0-based). */
  readonly hunkIndex: number;
  /** Reason for rejection. */
  readonly reason: string;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Agent-Computer Interface — semantic OS for LLM agents.
 *
 * Replaces raw file I/O tools with structured, AST-aware operations
 * that reduce hallucination and improve code manipulation accuracy.
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface IAgentComputerInterface {
  /**
   * Navigate the TypeScript AST by semantic path.
   * Instead of reading raw lines, agents traverse the code graph.
   *
   * @param filePath - Relative path to the file
   * @param nodePath - Dot-separated path (e.g. "MyClass.myMethod")
   * @param correlationId - Request correlation ID for tracing
   */
  navigateAST(
    filePath: string,
    nodePath: string | undefined,
    correlationId: CorrelationId,
  ): Promise<ASTNavigationResult>;

  /**
   * Run a test file in a sandboxed V8 isolate.
   * No access to main process network, filesystem, or environment.
   *
   * @param testFile - Relative path to the test file
   * @param options - Sandbox configuration
   * @param correlationId - Request correlation ID for tracing
   */
  runSandboxTest(
    testFile: string,
    options: SandboxTestOptions | undefined,
    correlationId: CorrelationId,
  ): Promise<SandboxTestResult>;

  /**
   * Apply a unified diff patch to one or more files.
   * Uses strict matching (no fuzz factor) to prevent silent corruption.
   *
   * @param patchString - Unified diff format string
   * @param correlationId - Request correlation ID for tracing
   */
  applyDiffPatch(
    patchString: string,
    correlationId: CorrelationId,
  ): Promise<DiffPatchResult>;
}
