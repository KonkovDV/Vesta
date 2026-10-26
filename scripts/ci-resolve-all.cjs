'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applyGateEnv, unexpectedResolveFailures } = require('./ci-gates-lib.cjs');

applyGateEnv({ ENABLE_HTTP: 'false' });

const watchdog = setTimeout(() => {
  console.error('GATE-TIMEOUT resolve-all');
  process.exit(1);
}, 180000);

async function main() {
  const dist = path.join(__dirname, '..', 'dist');
  const kernel = require(path.join(dist, 'kernel.js'));
  await kernel.runKernel({ processHandlers: false });
  const { container } = require(path.join(dist, 'core', 'di', 'container.js'));
  const services = container.getAllServices();
  const failures = [];
  for (const service of services) {
    const token = String(service.token);
    try {
      container.resolve(service.token);
    } catch (error) {
      const message = (error && error.message ? error.message : String(error)).split('\n')[0].slice(0, 160);
      failures.push({ token, message });
    }
  }
  const budget = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'gates', 'resolve-all-budget.json'), 'utf8'));
  const unexpected = unexpectedResolveFailures(failures, budget.tokens);
  console.log(`RESOLVE-ALL registered=${services.length} failed=${failures.length} budget=${budget.tokens.length} unexpected=${unexpected.length}`);
  for (const failure of failures) console.log(`FAIL ${failure.token}: ${failure.message}`);
  if (unexpected.length > 0) {
    console.error(`GATE-FAIL new unresolved tokens: ${unexpected.join(', ')}`);
    process.exit(1);
  }
  const failedNames = new Set(failures.map((failure) => failure.token));
  const resolved = budget.tokens.filter((token) => !failedNames.has(token));
  if (resolved.length > 0) console.log(`GATE-BUDGET-CAN-SHRINK ${resolved.join(', ')}`);
  console.log('GATE-OK resolve-all');
  clearTimeout(watchdog);
  process.exit(0);
}

main().catch((error) => {
  console.error(`BOOT-FAILED ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
