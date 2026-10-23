/**
 * TIM LSP Server DI Module.
 *
 * Registers lightweight metadata for the TIM LSP server (Horizon 0).
 * The actual LSP server runs as a standalone stdio process, so only
 * metadata is registered here (same pattern as MCP server DI modules).
 *
 * @module infrastructure/di/modules
 * @pattern TIM Horizon 0 — LSP Red-Line Bridge
 * @see src/infrastructure/lsp/TIMLspServer.ts — LSP server entry point
 */

import { container } from '../../../core/di/container';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';

const log = getBootstrapLogger('tim-lsp');
const MODULE_VERSION = '0.1.0';

export function registerTIMLspModule(): void {
  if (container.isRegistered(DI_TOKENS.ITIMLspServer)) return;

  try {
    container.register(
      DI_TOKENS.ITIMLspServer,
      () => ({
        name: 'tim-lsp',
        version: MODULE_VERSION,
        protocol: 'LSP',
        transport: 'stdio',
      }),
      {
        lifecycle: 'singleton',
        tags: ['lsp', 'tim', 'diagnostics', 'dev-tool'],
        description: 'TIM LSP Server metadata (Horizon 0 — LSP Red-Line Bridge)',
      },
    );
  } catch (err) {
    log.error(`[tim-lsp] DI registration failed: ${String(err)}`);
    throw err;
  }
}
