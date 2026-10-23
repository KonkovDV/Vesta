/**
 * IFormalProofEngine — Domain port for Formal Verification (Lean 4 / Coq).
 *
 * Layer: Domain (port / contract)
 *
 * Abstracts interactive theorem provers behind a compilation-oriented interface.
 * Infrastructure adapters bridge to Lean 4 (preferred) or Coq via local toolchain
 * or container-sandboxed execution.
 *
 * Motivation: LLM-as-Judge (ILlmJudge) is inherently stochastic — it provides
 * heuristic confidence but cannot offer *mathematical guarantees* that an agent's
 * code or action plan adheres to ConstitutionalGuard invariants. Formal verification
 * via interactive theorem provers closes this gap.
 *
 * Workflow (Zero-Trust Pipeline):
 *   1. Translation — the Planning Agent expresses intended changes as a formal spec
 *   2. Generation — a specialized LLM actor generates the proof (Lean 4 script)
 *   3. Verification — FormalProverAdapter compiles the proof locally
 *   4. Gate — StructuredReasoningAdapter locks "Execute" phase until proof compiles
 *
 * @Horizon 4 — Singularity Core Auditor (Phase 8)
 * @see MA-LoT (Multi-Agent Lean-of-Thought) — arXiv 2025
 * @see AutoRocq / CoqPilot — JetBrains Research 2025
 * @see 61_PHASE_8_SINGULARITY_AUDITOR.md §8.2
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ──────────────────────────────────────────────────────────

/** Supported formal verification backends. */
export type ProverBackend = 'lean4' | 'coq';

/** Compilation status of a formal proof attempt. */
export type ProofStatus = 'verified' | 'compilation_error' | 'timeout' | 'unsupported';

/**
 * Formal specification — a set of invariants expressed in natural language
 * and (optionally) their formal representation.
 */
export interface FormalSpecification {
  /** Human-readable description of the invariant */
  readonly description: string;
  /** Invariant category (maps to ConstitutionalRule categories) */
  readonly category: 'architecture' | 'security' | 'data_safety' | 'compliance' | 'semantic';
  /** Formal expression in the target prover language (Lean 4 / Coq) */
  readonly formalExpression?: string;
  /** Source rule ID (e.g., "arch.no-infra-in-domain") from ConstitutionalGuard */
  readonly sourceRuleId?: string;
}

/**
 * A proof script submitted for compilation.
 */
export interface ProofScript {
  /** The full proof script (Lean 4 or Coq/Rocq source) */
  readonly source: string;
  /** Which prover backend to compile against */
  readonly backend: ProverBackend;
  /** The invariants this proof claims to verify */
  readonly specifications: readonly FormalSpecification[];
  /** Timeout in milliseconds for compilation */
  readonly timeoutMs?: number;
}

/**
 * Result of a formal proof compilation attempt.
 */
export interface ProofCompilationResult {
  /** Overall proof status */
  readonly status: ProofStatus;
  /** The backend that was used */
  readonly backend: ProverBackend;
  /** Will be true only if status === 'verified' */
  readonly isVerified: boolean;
  /** Detailed compiler output (errors, warnings) */
  readonly compilerOutput: string;
  /** List of unsatisfied goals (if compilation_error) */
  readonly unsatisfiedGoals: readonly string[];
  /** Time taken in milliseconds */
  readonly compilationTimeMs: number;
  /** Number of invariants successfully proven */
  readonly provenCount: number;
  /** Total number of invariants in the specification */
  readonly totalCount: number;
}

/**
 * Request to generate a formal proof for a plan.
 * This is the input to the "Generation" phase where an LLM
 * actor produces the Lean 4 / Coq proof script.
 */
export interface ProofGenerationRequest {
  /** The plan or action to be formally verified */
  readonly planDescription: string;
  /** The invariants that must hold */
  readonly invariants: readonly FormalSpecification[];
  /** Preferred prover backend */
  readonly preferredBackend: ProverBackend;
  /** Maximum number of LLM retries for proof generation */
  readonly maxRetries?: number;
  /** Correlation ID for tracing */
  readonly correlationId: CorrelationId;
}

/**
 * Result of the proof generation + compilation pipeline.
 */
export interface FormalVerificationResult {
  /** Whether the plan was formally verified (proof compiled) */
  readonly verified: boolean;
  /** The proof script that was generated (if any) */
  readonly proofScript?: ProofScript;
  /** Compilation result (if proof was generated) */
  readonly compilationResult?: ProofCompilationResult;
  /** Number of attempts made to generate a valid proof */
  readonly attempts: number;
  /** Total duration of the generation + compilation pipeline (ms) */
  readonly totalDurationMs: number;
  /** Human-readable explanation of the verification outcome */
  readonly explanation: string;
}

// ── Port Interface ──────────────────────────────────────────────────

/**
 * Formal Proof Engine — compiles and verifies Lean 4 / Coq proofs,
 * providing mathematical guarantees for agent action plans.
 *
 * Used by StructuredReasoningAdapter as a zero-trust execution gate:
 * the Execute phase is locked until this engine returns `verified: true`.
 *
 * @see DI_TOKENS.IFormalProofEngine
 */
export interface IFormalProofEngine {
  /**
   * Compile a proof script against the specified backend.
   * Low-level interface — callers provide the proof script directly.
   *
   * @param script — the proof script to compile
   * @param correlationId — tracing ID for audit logging
   * @returns compilation result
   */
  compileProof(
    script: ProofScript,
    correlationId: CorrelationId,
  ): Promise<ProofCompilationResult>;

  /**
   * Full verification pipeline: generate a proof from a plan description
   * and compile it. This is the primary entry point for the execution gate.
   *
   * Steps:
   *   1. Translate plan + invariants → formal specification
   *   2. Ask LLM to generate a Lean 4 / Coq proof script
   *   3. Compile the proof script locally
   *   4. If compilation fails, retry (up to maxRetries)
   *
   * @param request — proof generation request with plan + invariants
   * @returns verification result (verified: true/false + details)
   */
  verifyPlan(
    request: ProofGenerationRequest,
  ): Promise<FormalVerificationResult>;

  /**
   * Translate ConstitutionalGuard rules into formal specifications
   * suitable for inclusion in Lean 4 / Coq proof scripts.
   *
   * @param rules — constitutional rules to formalize
   * @param backend — target prover backend
   * @returns formal specifications
   */
  translateRulesToSpec(
    rules: readonly { readonly ruleId: string; readonly description: string; readonly category: string }[],
    backend: ProverBackend,
  ): FormalSpecification[];

  /**
   * Check whether the specified prover backend is available
   * (toolchain installed and accessible).
   *
   * @param backend — the prover backend to check
   * @returns true if the prover is available for compilation
   */
  isBackendAvailable(backend: ProverBackend): Promise<boolean>;

  /**
   * Get the list of supported prover backends.
   */
  getSupportedBackends(): readonly ProverBackend[];
}
