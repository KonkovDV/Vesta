'use strict';

/**
 * Pure helpers for the CI gates (T1.7).
 * The route walker needs installRoutePathCapture() before Express loads:
 * Express 5 keeps the mount path in a closure, not on the layer.
 */

function installRoutePathCapture() {
  const layerPath = require.resolve('router/lib/layer');
  const Original = require(layerPath);
  if (Original.__routePathCapture) return;
  function Layer(path, options, fn) {
    if (!(this instanceof Layer)) return new Layer(path, options, fn);
    Original.call(this, path, options, fn);
    this.registeredPath = path;
  }
  Layer.prototype = Original.prototype;
  Layer.__routePathCapture = true;
  require.cache[layerPath].exports = Layer;
}

function joinRoute(prefix, routePath) {
  const left = !prefix || prefix === '/' ? '' : String(prefix).replace(/\/+$/, '');
  if (!routePath || routePath === '/') return left || '/';
  const right = String(routePath).startsWith('/') ? String(routePath) : `/${routePath}`;
  return `${left}${right}`;
}

function walkExpressStack(stack, prefix = '') {
  const routes = [];
  const misses = [];
  for (const layer of stack || []) {
    if (layer && layer.route) {
      const routePath = joinRoute(prefix, layer.route.path);
      const methods = layer.route.methods || {};
      for (const method of Object.keys(methods)) {
        if (!methods[method]) continue;
        if (method === 'head' && methods.get) continue;
        routes.push({ method: method.toUpperCase(), path: routePath });
      }
      continue;
    }
    if (layer && layer.handle && Array.isArray(layer.handle.stack)) {
      if (typeof layer.registeredPath !== 'string') {
        misses.push(layer.name || 'router');
      }
      const mounted = layer.registeredPath;
      const next = typeof mounted === 'string' && mounted !== '/'
        ? joinRoute(prefix, mounted)
        : prefix;
      const nested = walkExpressStack(layer.handle.stack, next);
      routes.push(...nested.routes);
      misses.push(...nested.misses);
    }
  }
  return { routes, misses };
}

function fillRouteParams(routePath) {
  return String(routePath)
    .replace(/:([A-Za-z0-9_]+)\??/g, 'probe')
    .replace(/\*/g, 'probe');
}

function unexpectedOpenRoutes(results, allowlist) {
  const allowed = new Set(allowlist);
  const unexpected = [];
  for (const row of results) {
    if (row.status === 401 || row.status === 403 || row.status === 404) continue;
    const key = `${row.method} ${row.path}`;
    if (!allowed.has(key)) unexpected.push(key);
  }
  return unexpected;
}

function unexpectedResolveFailures(failures, budget) {
  const allowed = new Set(budget);
  const unexpected = [];
  for (const row of failures) {
    if (!allowed.has(row.token)) unexpected.push(row.token);
  }
  return unexpected;
}

function applyGateEnv(overrides) {
  const defaults = {
    NODE_ENV: 'development',
    PORT: '3901',
    USE_MOCK_AI: 'true',
    OTEL_SDK_DISABLED: 'true',
    ENABLE_HTTP: 'false',
    JWT_SECRET: 'ci-gate-secret-ci-gate-secret-0001',
    STANDARD_PLUGINS: '',
    EVENT_BUS_REQUIRE_SUBSCRIBER: 'false',
    BFF_API_KEY: 'ci-gate-bff-key-not-secret',
    FF_USEREALEVENTSTORE: 'true',
    FF_USEREALEVENTBUS: 'true',
    FF_USEREALOUTBOX: 'true',
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides || {})) process.env[key] = value;
}

module.exports = {
  installRoutePathCapture,
  joinRoute,
  walkExpressStack,
  fillRouteParams,
  unexpectedOpenRoutes,
  unexpectedResolveFailures,
  applyGateEnv,
};
