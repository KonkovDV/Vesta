import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPgSslConfig } from '../../src/infrastructure/persistence/pg-ssl-config';

test('DB_SSL=true verifies the server certificate', () => {
  const ssl = buildPgSslConfig({ DB_SSL: 'true' });
  assert.equal(ssl?.rejectUnauthorized, true);
});

test('DB_SSL_REJECT_UNAUTHORIZED=false is the explicit opt-out', () => {
  const ssl = buildPgSslConfig({
    DB_SSL: 'true',
    DB_SSL_REJECT_UNAUTHORIZED: 'false',
  });
  assert.equal(ssl?.rejectUnauthorized, false);
});

test('DB_SSL unset leaves the connection without an ssl option', () => {
  assert.equal(buildPgSslConfig({}), undefined);
});
