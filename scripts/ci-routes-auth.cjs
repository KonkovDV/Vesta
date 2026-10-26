'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  installRoutePathCapture,
  applyGateEnv,
  walkExpressStack,
  fillRouteParams,
  unexpectedOpenRoutes,
} = require('./ci-gates-lib.cjs');

installRoutePathCapture();
applyGateEnv({ ENABLE_HTTP: 'true', PORT: process.env.CI_GATE_PORT || '3901' });

const watchdog = setTimeout(() => {
  console.error('GATE-TIMEOUT routes-auth');
  process.exit(1);
}, 180000);

async function probe(port, route) {
  const url = `http://127.0.0.1:${port}${fillRouteParams(route.path)}`;
  const method = route.method;
  try {
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
      signal: AbortSignal.timeout(4000),
    });
    await response.body?.cancel?.();
    return response.status;
  } catch {
    return -1;
  }
}

async function main() {
  const dist = path.join(__dirname, '..', 'dist');
  const kernel = require(path.join(dist, 'kernel.js'));
  const started = await kernel.runKernel({ processHandlers: false });
  if (!started || !started.app) {
    console.error('BOOT-FAILED HTTP server did not start');
    process.exit(1);
  }
  const app = started.app;
  const stack = app.router?.stack ?? app._router?.stack;
  if (!stack) {
    console.error('GATE-NO-ROUTER');
    process.exit(1);
  }
  const walked = walkExpressStack(stack);
  if (walked.misses.length > 0) {
    console.error(`GATE-WALKER-MISS ${walked.misses.join(', ')}`);
    process.exit(1);
  }
  const results = [];
  for (const route of walked.routes) {
    const status = await probe(started.port, route);
    results.push({ ...route, status });
    console.log(`ROUTE ${String(status).padEnd(4)} ${route.method.padEnd(6)} ${route.path}`);
  }
  const allowlist = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'gates', 'public-routes.json'), 'utf8'));
  const unexpected = unexpectedOpenRoutes(results, allowlist.routes);
  const protectedCount = results.filter((row) => row.status === 401 || row.status === 403).length;
  console.log(`ROUTES total=${results.length} protected=${protectedCount} unexpected=${unexpected.length}`);
  if (unexpected.length > 0) {
    console.error(`GATE-FAIL open routes: ${unexpected.join(', ')}`);
    process.exit(1);
  }
  console.log('GATE-OK routes-auth');
  clearTimeout(watchdog);
  process.exit(0);
}

main().catch((error) => {
  console.error(`BOOT-FAILED ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
