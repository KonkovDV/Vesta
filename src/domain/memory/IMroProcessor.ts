/**
 * IMroProcessor — Domain Port for Language-Aware Method Resolution Order.
 *
 * Computes C3-linearized MRO for classes that use multiple inheritance,
 * mixins, or trait-based hierarchies. Essential for Python, C++, Rust,
 * and Java/Kotlin codebases where method override chains matter.
 *
 * Layer: Domain
 * Pattern source: GitNexus v1.4.0 ingestion/mro.ts (U14, patterns only)
 * License: PolyForm-Noncommercial — original implementation
 */

import type { TenantId, CorrelationId } from './session-types';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** Supported languages for MRO computation. */
export type MroLanguage = 'python' | 'cpp' | 'rust' | 'java' | 'kotlin' | 'typescript' | 'ruby' | 'scala' | 'elixir';

/** Algorithm used for resolution. */
export type MroAlgorithm = 'c3_linearization' | 'depth_first' | 'breadth_first';

/** A single class/type in the inheritance hierarchy. */
export interface MroClassEntry {
  readonly name: string;
  readonly filePath: string;
  /** Direct base classes / mixins / traits, in declared order. */
  readonly bases: readonly string[];
  readonly language: MroLanguage;
}

/** A method override in the resolution chain. */
export interface MethodOverride {
  readonly className: string;
  readonly methodName: string;
  readonly filePath: string;
  readonly line: number;
  /** Position in the MRO chain (0 = most specific). */
  readonly mroIndex: number;
}

/** Full MRO resolution result for a single class. */
export interface MroResolutionResult {
  /** The target class. */
  readonly className: string;
  /** Linearized resolution order (most specific first). */
  readonly order: readonly string[];
  /** Algorithm used. */
  readonly algorithm: MroAlgorithm;
  /** Method-level override chains. */
  readonly overrides: readonly MethodOverride[];
  /** Diamond inheritance detected. */
  readonly hasDiamond: boolean;
  /** C3 linearization conflict (unresolvable). */
  readonly hasConflict: boolean;
  /** Human-readable conflict description, if any. */
  readonly conflictDescription?: string;
}

// ──────────────────────────────────────────────
// Domain Port
// ──────────────────────────────────────────────

/**
 * MRO Processor — Domain Port (L3).
 *
 * Computes method resolution order for classes with complex inheritance.
 * Detects diamond inheritance, C3 conflicts, and method override chains.
 *
 * Implementations: MroProcessorAdapter (infrastructure).
 */
export interface IMroProcessor {
  /** Compute MRO for a given class within its inheritance hierarchy. */
  resolve(input: {
    tenantId: TenantId;
    /** Target class name. */
    className: string;
    /** All classes in the hierarchy (superset). */
    hierarchy: readonly MroClassEntry[];
    /** Optional: specific method to track overrides for. */
    methodName?: string;
    correlationId: CorrelationId;
  }): Promise<MroResolutionResult>;
}
