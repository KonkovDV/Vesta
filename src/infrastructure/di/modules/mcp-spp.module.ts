/**
 * MCP SPP Server DI module.
 *
 * Registers the dev-time MCP SPP (Scientific Publication Protocol) Server
 * for DI resolution. This is separate from the runtime MCP servers.
 *
 * The SPP Server is a standalone stdio process — we register
 * only metadata here for DI smoke tests and module discovery.
 *
 * @see src/infrastructure/mcp/spp/MicroPhoenixSppMcpServer.ts
 */

import { container } from '../../../core/di/container';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { DI_TOKENS } from '@/core/di/DI_TOKENS';

const log = getBootstrapLogger('mcp-spp');

export function registerMcpSppModule(): void {
  if (container.isRegistered(DI_TOKENS.IMcpSppServer)) return;

  try {
    // The MCP SPP Server is a standalone stdio process, not a runtime service.
    // We register a factory that returns server metadata for DI resolution tests.
    container.register<{ name: string; version: string }>(
      'IMcpSppServer',
      () => ({
        name: 'microphoenix-spp',
        version: '1.0.0',
      }),
      {
        lifecycle: 'singleton',
        tags: ['mcp', 'spp', 'dev-tool'],
        description: 'MCP SPP Server metadata (Scientific Publication Protocol)',
      },
    );

    log.info('✓ MCP SPP Server registered');
  } catch (error) {
    log.error('✗ Failed to register MCP SPP Server:', { error });
  }
}
