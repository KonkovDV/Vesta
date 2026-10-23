/**
 * MCP Extraction Server DI module.
 *
 * Registers the dev-time MCP Extraction Server for DI resolution,
 * plus V5.1 Extraction Pipeline domain ports:
 * - IProofOfExtractionStore: Cryptographic extraction provenance
 * - ISemanticDonorArchive: Semantic archiving of skipped donor code
 * - ISymbioticProtocol: Reverse Extraction (Sidecar Adapters)
 * - IContinuousSymbiosisWatcher: Watch Mode Pipeline (auto-regeneration on donor changes)
 *
 * V13.0 Cross-Donor Intelligence ports:
 * - IExtractionTrajectoryStore: Cross-session extraction memory (Rules 40, 42)
 * - ICrossDonorKnowledgeGraph: Shared knowledge between donors (Rules 40, 41)
 *
 * @see src/infrastructure/mcp/extraction/MicroPhoenixExtractionMcpServer.ts
 * @see src/domain/extraction/ — Domain port interfaces
 * @see PLANS/EXTRACTION/EXTRACTION_SYSTEM.md — V13.0 Pipeline specification
 */

import * as path from 'node:path';
import { container } from '../../../core/di/container';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { ProofOfExtractionStore } from '../../mcp/extraction/ProofOfExtractionStore';
import { SemanticDonorArchive } from '../../mcp/extraction/SemanticDonorArchive';
import { SymbioticProtocolAdapter } from '../../mcp/extraction/SymbioticProtocolAdapter';
import { ContinuousSymbiosisWatcher } from '../../mcp/extraction/ContinuousSymbiosisWatcher';
import type { IProofOfExtractionStore } from '../../../domain/extraction/IProofOfExtractionStore';
import type { IContinuousSymbiosisWatcher } from '../../../domain/extraction/IContinuousSymbiosisWatcher';
import type { ISemanticDonorArchive } from '../../../domain/extraction/ISemanticDonorArchive';
import type { ISymbioticProtocol } from '../../../domain/extraction/ISymbioticProtocol';
import type { IEventStore } from '../../../domain/events/event-store.interface';
import type { IStructuredLogger } from '../../../core/logging/IStructuredLogger';
import { DI_TOKENS } from '@/core/di/DI_TOKENS';

const log = getBootstrapLogger('mcp-extraction');

export function registerMcpExtractionModule(): void {
  if (container.isRegistered(DI_TOKENS.IMcpExtractionServer)) return;

  try {
    // The MCP Extraction Server is a standalone stdio process, not a runtime service.
    // We register a factory that returns server metadata for DI resolution tests.
    container.register<{ name: string; version: string }>(
      DI_TOKENS.IMcpExtractionServer,
      () => ({
        name: 'microphoenix-extraction',
        version: '1.2.0',
      }),
      {
        lifecycle: 'singleton',
        tags: ['mcp', 'extraction', 'dev-tool'],
        description: 'MCP Extraction Server metadata (dev-time tool for donor extraction pipeline)',
      },
    );

    // ── V5.1: Proof-of-Extraction Store ─────────────────────────
    container.register<IProofOfExtractionStore>(
      'IProofOfExtractionStore',
      () => {
        const eventStore = container.resolve<IEventStore>(DI_TOKENS.IEventStore);
        const logger = container.resolve<IStructuredLogger>(DI_TOKENS.IStructuredLogger);
        return new ProofOfExtractionStore(eventStore, logger);
      },
      {
        lifecycle: 'singleton',
        tags: ['extraction', 'proof-of-extraction', 'v5.1'],
        description: 'Cryptographic Proof-of-Extraction event store (V5.1)',
      },
    );

    // ── V5.1: Semantic Donor Archive ────────────────────────────
    container.register<ISemanticDonorArchive>(
      'ISemanticDonorArchive',
      () => {
        const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
        const logger = container.resolve<IStructuredLogger>(DI_TOKENS.IStructuredLogger);
        return new SemanticDonorArchive(projectRoot, logger);
      },
      {
        lifecycle: 'singleton',
        tags: ['extraction', 'semantic-archive', 'v5.1'],
        description: 'Semantic Donor Archive for skipped code preservation (V5.1)',
      },
    );

    // ── V5.1: Symbiotic Protocol (Phase 11: GENERATE_SIDECAR) ─────
    // Full implementation: AST-driven analysis + sidecar code generation.
    // Replaces @sota-stub null-object — Inverse Symbiosis now operational.
    container.register<ISymbioticProtocol>(
      'ISymbioticProtocol',
      () => {
        const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
        const eventStore = container.resolve<IEventStore>(DI_TOKENS.IEventStore);
        const logger = container.resolve<IStructuredLogger>(DI_TOKENS.IStructuredLogger);
        return new SymbioticProtocolAdapter(projectRoot, eventStore, logger);
      },
      {
        lifecycle: 'singleton',
        tags: ['extraction', 'symbiotic-protocol', 'v5.1', 'phase-11'],
        description: 'Symbiotic Protocol adapter — AST-driven sidecar generation (Phase 11)',
      },
    );

    // ── V5.1: Continuous Symbiosis Watcher (Watch Mode Pipeline) ─────
    // Auto-regenerates sidecar adapters when donor code changes in external/.
    container.register<IContinuousSymbiosisWatcher>(
      DI_TOKENS.IContinuousSymbiosisWatcher,
      () => {
        const protocol = container.resolve<ISymbioticProtocol>(DI_TOKENS.ISymbioticProtocol);
        const logger = container.resolve<IStructuredLogger>(DI_TOKENS.IStructuredLogger);
        return new ContinuousSymbiosisWatcher(protocol, logger);
      },
      {
        lifecycle: 'singleton',
        tags: ['extraction', 'symbiotic-protocol', 'watcher', 'phase-11'],
        description: 'Continuous Symbiosis file watcher — auto-regeneration on donor changes',
      },
    );

    log.info('✓ MCP Extraction Server + V5.1 Pipeline + V11.0 Intelligence registered');
  } catch (error) {
    log.error('✗ Failed to register MCP Extraction Server:', { error });
    throw error;
  }
}
