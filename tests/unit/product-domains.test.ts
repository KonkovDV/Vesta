/**
 * ADR-0005: product domains that still live in this tree are off unless a
 * deployment turns each one on with MODULE_<NAME>_ENABLED=true.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_DOMAINS, productDomainEnabled } from '../../src/config/product-domains';
import { registerDefaultHttpRoutes } from '../../src/presentation/http/register-default-routes';

const FLAGS = ['MODULE_SALES_ENABLED', 'MODULE_HR_ENABLED', 'MODULE_HEALTHCARE_ENABLED', 'MODULE_RESEARCH_ENABLED', 'MODULE_X402_ENABLED'];

function withFlags(values: Record<string, string | undefined>, work: () => void): void {
  const previous = Object.fromEntries(FLAGS.map((key) => [key, process.env[key]]));
  for (const key of FLAGS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function mountedPaths(): string[] {
  const paths: string[] = [];
  const app = { use: (first: unknown) => { if (typeof first === 'string') paths.push(first); } };
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  registerDefaultHttpRoutes(app as never, { authMw: pass, rateLimitMw: pass } as never);
  return paths;
}

test('every product domain is off unless its flag is true', () => {
  withFlags({}, () => {
    assert.deepEqual(PRODUCT_DOMAINS.filter((domain) => productDomainEnabled(domain)), []);
  });
  withFlags({ MODULE_HEALTHCARE_ENABLED: 'true', MODULE_SALES_ENABLED: '1', MODULE_HR_ENABLED: 'yes' }, () => {
    assert.deepEqual(PRODUCT_DOMAINS.filter((domain) => productDomainEnabled(domain)), ['sales', 'healthcare']);
  });
});

test('the kernel mounts no product route unless that domain is on', () => {
  withFlags({}, () => {
    const paths = mountedPaths();
    for (const prefix of ['/api/v1/sales', '/api/v1/hr', '/api/v1/healthcare']) {
      assert.equal(paths.includes(prefix), false, prefix);
    }
    assert.ok(paths.includes('/api/v1/memory/ingest'), 'document ingestion is kernel memory, not a product');
    assert.ok(paths.includes('/api/v1/identity'));
  });
  withFlags({ MODULE_SALES_ENABLED: 'true', MODULE_HEALTHCARE_ENABLED: 'true' }, () => {
    const paths = mountedPaths();
    assert.ok(paths.includes('/api/v1/sales'));
    assert.ok(paths.includes('/api/v1/healthcare'));
    assert.equal(paths.includes('/api/v1/hr'), false);
  });
});
