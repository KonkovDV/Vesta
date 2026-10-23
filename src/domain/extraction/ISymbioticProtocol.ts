/**
 * ISymbioticProtocol — Domain port for Reverse Extraction (Symbiosis).
 *
 * Layer: Domain
 *
 * Instead of absorbing external code into MicroPhoenix (classical extraction),
 * the Symbiotic Protocol projects MicroPhoenix capabilities outward into legacy
 * systems. It injects lightweight Sidecar Adapters that wrap legacy components
 * with Event Sourcing bridges, bringing them under the MicroPhoenix domain
 * without complete rewrites.
 *
 * Horizon 2 alignment: Planetary OS — MicroPhoenix orchestrates external systems
 * by "infecting" them with compliance nodes (Event Sourcing + DI adapters).
 *
 * @see PLANS/DOCS_AUDIT_2026/71_EXTRACTION_V5_SOTA_AUDIT_MARCH_2026.md §2.3
 * @see PLANS/EXTRACTION/EXTRACTION_SYSTEM.md — V13.0 Pipeline specification
 */

import type { CorrelationId } from '../../core/context/IRequestContext';

// ── Sidecar Adapter Types ───────────────────────────────────────────

/** Types of sidecar adapters that can be generated */
export type SidecarAdapterType =
  | 'event_bridge'      // Event Sourcing bridge (emits DomainEvents)
  | 'di_wrapper'        // DI-compatible wrapper around legacy service
  | 'health_probe'      // Health check endpoint adapter
  | 'metrics_exporter'; // Prometheus metrics exporter

/**
 * Specification for a sidecar adapter to be generated.
 */
export interface SidecarAdapterSpec {
  /** Type of adapter to generate */
  readonly adapterType: SidecarAdapterType;
  /** Target legacy module/class to wrap */
  readonly targetModule: string;
  /** Public API methods to bridge */
  readonly bridgedMethods: readonly string[];
  /** Event types to emit when bridged methods are called */
  readonly emittedEvents: readonly string[];
  /** Target path for the generated adapter */
  readonly outputPath: string;
}

/**
 * Analysis result for a legacy system's symbiosis compatibility.
 */
export interface SymbiosisAnalysis {
  /** Legacy system identifier */
  readonly systemName: string;
  /** Number of modules analyzed */
  readonly modulesAnalyzed: number;
  /** Number of modules compatible with sidecar injection */
  readonly compatibleModules: number;
  /** Recommended sidecar adapters */
  readonly recommendedAdapters: readonly SidecarAdapterSpec[];
  /** Risk assessment (low/medium/high) */
  readonly riskLevel: 'low' | 'medium' | 'high';
  /** Estimated effort in developer-days */
  readonly estimatedEffort: number;
}

/**
 * Result of generating a sidecar adapter.
 */
export interface SidecarGenerationResult {
  /** Path to the generated adapter file */
  readonly generatedPath: string;
  /** Adapter type */
  readonly adapterType: SidecarAdapterType;
  /** Whether generation was successful */
  readonly success: boolean;
  /** Error message if generation failed */
  readonly errorMessage?: string;
  /** Number of bridged methods */
  readonly bridgedMethodCount: number;
}

// ── Domain Port ─────────────────────────────────────────────────────

/**
 * Domain port for the Symbiotic Protocol (Reverse Extraction).
 *
 * Infrastructure layer implements this by:
 * 1. Analyzing the legacy system's module structure
 * 2. Identifying Event Sourcing bridge points
 * 3. Generating Sidecar Adapters that wrap legacy APIs
 * 4. Emitting DomainEvents into the MicroPhoenix Event Store
 */
export interface ISymbioticProtocol {
  /**
   * Analyze a legacy system for symbiosis compatibility.
   *
   * @param systemPath — path to the legacy system root
   * @param systemName — identifier for the legacy system
   * @param correlationId — tracing ID
   * @returns analysis result with compatibility assessment
   */
  analyzeSystem(
    systemPath: string,
    systemName: string,
    correlationId: CorrelationId,
  ): Promise<SymbiosisAnalysis>;

  /**
   * Generate a sidecar adapter for a specific legacy module.
   *
   * @param spec — adapter specification
   * @param correlationId — tracing ID
   * @returns generation result with output path
   */
  generateSidecarAdapter(
    spec: SidecarAdapterSpec,
    correlationId: CorrelationId,
  ): Promise<SidecarGenerationResult>;

  /**
   * Validate that a generated sidecar adapter correctly bridges
   * the legacy module's public API.
   *
   * @param adapterPath — path to the generated adapter
   * @param originalModulePath — path to the original legacy module
   * @param correlationId — tracing ID
   * @returns true if the adapter correctly wraps all specified methods
   */
  validateAdapter(
    adapterPath: string,
    originalModulePath: string,
    correlationId: CorrelationId,
  ): Promise<boolean>;
}
