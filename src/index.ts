/**
 * Application entry point of the MicroPhoenix server.
 *
 * Startup lives in src/kernel.ts so a project built on the kernel can call the
 * same `runKernel()` with its own extensions:
 *   0) System integrity checks
 *   1) Infrastructure (DI bootstrap)
 *   2) Application
 *   3) Presentation (HTTP)
 */
import { runKernel } from './kernel';

void runKernel().catch((error: unknown) => {
  console.error('[EntryPoint] Bootstrap failed:', error);
  process.exit(1);
});
