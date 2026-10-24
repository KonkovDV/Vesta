/**
 * Minimal environment for unit tests. Modules such as aop/aspect-config read the
 * configuration at import time, so these values must exist before any import.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  OTEL_SDK_DISABLED: 'true',
  USE_MOCK_AI: 'true',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
  DB_PASSWORD: 'test',
  REDIS_HOST: '127.0.0.1',
  JWT_SECRET: 'test-secret-test-secret-test-secret-0000',
};
for (const [key, value] of Object.entries(defaults)) {
  if (process.env[key] === undefined) process.env[key] = value;
}
