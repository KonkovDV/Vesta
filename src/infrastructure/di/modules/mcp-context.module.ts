/**
 * MCP Context Server DI module.
 *
 * Registers the dev-time MCP Context Server for IDE integration.
 * This is separate from the runtime McpMemoryServer (mcp.module.ts if any).
 *
 * Phase CE-1: Context Engineering Horizon 1.
 * @see src/infrastructure/mcp/context/MicroPhoenixMcpServer.ts
 */

import { container } from '../../../core/di/container';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import * as path from 'node:path';
import { SharedASTCacheAdapter } from '../../mcp/shared/SharedASTCacheAdapter';

const log = getBootstrapLogger('mcp-context');

export function registerMcpContextModule(): void {
  if (container.isRegistered(DI_TOKENS.IMcpContextServer)) return;

  try {
    // The MCP Context Server is a standalone stdio process, not a runtime service.
    // We register a factory that lazily loads the server class for DI resolution tests.
    container.register<{ name: string; version: string }>(
      'IMcpContextServer',
      () => ({
        name: 'microphoenix-context',
        version: '1.8.5',
      }),
      {
        lifecycle: 'singleton',
        tags: ['mcp', 'context', 'dev-tool'],
        description: 'MCP Context Server metadata (dev-time tool for IDE integration)',
      },
    );

    // SharedASTCacheAdapter: unified AST parsing cache for all MCP servers.
    // Eliminates duplication between InterfaceIndexer (regex) and ast-checker (ts-morph).
    if (!container.isRegistered(DI_TOKENS.ISharedASTCache)) {
      const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
      container.register<import('../../../domain/mcp/ISharedASTCache').ISharedASTCache>(
        DI_TOKENS.ISharedASTCache,
        () => new SharedASTCacheAdapter(projectRoot),
        {
          lifecycle: 'singleton',
          tags: ['mcp', 'ast', 'cache', 'shared'],
          description: 'Shared AST parsing cache: unified InterfaceIndexer + ts-morph cache across all MCP servers',
        },
      );
      log.info('✓ SharedASTCache registered');
    }

    log.info('✓ MCP Context Server registered');
  } catch (error) {
    log.error('✗ Failed to register MCP Context Server:', { error });
    throw error;
  }
}
