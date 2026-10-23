/**
 * MCP↔A2A Bridge DI module.
 *
 * Registers the runtime bridge that maps MCP tools to A2A skills.
 * The bridge remains usable even when IMcpServer is absent; readiness is
 * reported by the adapter itself so callers can degrade gracefully.
 *
 * @see src/infrastructure/mcp/McpA2ABridge.ts
 * @see src/domain/mcp/IMcpBridge.ts
 */

import { container } from '../../../core/di/container';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { IMcpServer } from '../../../domain/mcp/IMcpServer';
import { McpA2ABridge } from '../../mcp/McpA2ABridge';

const log = getBootstrapLogger('mcp-a2a-bridge');

export function registerMcpA2ABridgeModule(): void {
  if (container.isRegistered(DI_TOKENS.IMcpBridge)) {
    return;
  }

  try {
    container.register(
      DI_TOKENS.IMcpBridge,
      (c) => {
        const mcpServer = c.isRegistered(DI_TOKENS.IMcpServer)
          ? c.resolve<IMcpServer>(DI_TOKENS.IMcpServer)
          : undefined;
        const logger = c.isRegistered(DI_TOKENS.ILogger)
          ? c.resolve<ILogger>(DI_TOKENS.ILogger)
          : undefined;

        return new McpA2ABridge(mcpServer, logger);
      },
      {
        lifecycle: 'singleton',
        tags: ['mcp', 'a2a', 'bridge', 'runtime'],
        description: 'Runtime MCP↔A2A bridge resolved through IMcpBridge',
      },
    );

    log.info('✓ MCP↔A2A Bridge registered');
  } catch (error) {
    log.error('✗ Failed to register MCP↔A2A Bridge', { error });
    throw error;
  }
}