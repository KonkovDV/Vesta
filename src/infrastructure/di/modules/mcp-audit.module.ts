/**
 * MCP Audit Server DI module.
 *
 * Registers the dev-time MCP Audit Server for DI resolution.
 * This is separate from the runtime MCP servers (Memory, Context, Docs).
 *
 * The Audit Server is a standalone stdio process — we register
 * only metadata here for DI smoke tests and module discovery.
 *
 * @see src/infrastructure/mcp/audit/MicroPhoenixAuditMcpServer.ts
 */

import { container } from '../../../core/di/container';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { DI_TOKENS } from '@/core/di/DI_TOKENS';

const log = getBootstrapLogger('mcp-audit');

export function registerMcpAuditModule(): void {
  if (container.isRegistered(DI_TOKENS.IMcpAuditServer)) return;

  try {
    // The MCP Audit Server is a standalone stdio process, not a runtime service.
    // We register a factory that returns server metadata for DI resolution tests.
    container.register<{ name: string; version: string }>(
      'IMcpAuditServer',
      () => ({
        name: 'microphoenix-audit',
        version: '2.1.0',  // v2.1.0: MCP 2025-11-25, audit_risk_heatmap, SOTA March 2026
      }),
      {
        lifecycle: 'singleton',
        tags: ['mcp', 'audit', 'dev-tool'],
        description: 'MCP Audit Server metadata (dev-time continuous auditing tool)',
      },
    );

    log.info('✓ MCP Audit Server registered');
  } catch (error) {
    log.error('✗ Failed to register MCP Audit Server:', { error });
    throw error;
  }
}
