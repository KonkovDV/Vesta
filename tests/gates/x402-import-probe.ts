/**
 * Fresh process: does registering inter-agent services load the x402 payment modules?
 * argv[2] is "on" or "off".
 */
import { createRequire } from 'node:module';

async function main(): Promise<void> {
  const mode = process.argv[2];
  await import('../setup-env.ts');
  if (mode === 'on') process.env.MODULE_X402_ENABLED = 'true';
  else delete process.env.MODULE_X402_ENABLED;

  const { registerAgenticInterAgent } = await import('../../src/infrastructure/di/modules/agentic.module.ts');
  await registerAgenticInterAgent();

  const require = createRequire(__filename);
  const loaded = Object.keys(require.cache).some((key) => key.replace(/\\/g, '/').includes('/a2a/A2AX402PaymentAdapters'));
  const { container } = await import('../../src/core/di/container.ts');
  const { DI_TOKENS } = await import('../../src/core/di/DI_TOKENS.ts');
  console.log('X402_PROBE ' + JSON.stringify({
    loaded,
    registered: container.isRegistered(DI_TOKENS.IA2AX402MerchantPolicy),
  }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
