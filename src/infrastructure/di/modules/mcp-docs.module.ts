/**
 * MCP Docs Server DI module.
 *
 * Registers the dev-time MCP Documentation Server for IDE integration.
 * This is separate from the MCP Context Server (mcp-context.module.ts).
 *
 * Phase CE-2: Context Engineering — Documentation Context Server.
 * @see src/infrastructure/mcp/docs/MicroPhoenixDocsMcpServer.ts
 */

import { container } from '../../../core/di/container';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { DI_TOKENS } from '@/core/di/DI_TOKENS';

const log = getBootstrapLogger('mcp-docs');

export function registerMcpDocsModule(): void {
  if (container.isRegistered(DI_TOKENS.IMcpDocsServer)) return;

  try {
    // The MCP Docs Server is a standalone stdio process, not a runtime service.
    // We register a factory that provides server metadata for DI resolution tests.
    container.register<{ name: string; version: string }>(
      'IMcpDocsServer',
      () => ({
        name: 'microphoenix-docs',
        version: '1.8.0',
      }),
      {
        lifecycle: 'singleton',
        tags: ['mcp', 'docs', 'dev-tool'],
        description: 'MCP Documentation Server metadata (dev-time tool for IDE integration)',
      },
    );

    log.info('✓ MCP Docs Server registered');
  } catch (error) {
    log.error('✗ Failed to register MCP Docs Server:', { error });
    throw error;
  }
}
