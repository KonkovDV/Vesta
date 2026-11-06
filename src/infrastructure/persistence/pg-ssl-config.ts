/**
 * Shared PostgreSQL SSL configuration builder.
 *
 * Centralizes pg SSL config construction from environment variables,
 * ensuring consistent TLS behavior across all Pool instances.
 *
 * References:
 *   - node-postgres SSL: https://node-postgres.com/features/ssl
 *   - OWASP Transport Layer Security CS §2.5: Verify server certificates
 *   - NIST SP 800-52 Rev.2: TLS implementation guidelines
 *
 * Config keys:
 *   DB_SSL           = 'true' to enable SSL
 *   DB_SSL_CA        = PEM-encoded CA certificate (enables rejectUnauthorized: true)
 *   DB_SSL_CERT      = PEM-encoded client certificate (for mTLS)
 *   DB_SSL_KEY       = PEM-encoded client private key (for mTLS)
 *   DB_SSL_REJECT_UNAUTHORIZED = 'false' to explicitly disable cert verification
 */
import type { ConnectionOptions as TlsOptions } from 'tls';
import { readFileSync } from 'fs';

export interface PgSslConfig {
  ssl: TlsOptions | undefined;
}

/**
 * Build pg SSL config from environment config object.
 *
 * When DB_SSL_CA is provided, server certificate is validated against the CA.
 * When DB_SSL_CERT + DB_SSL_KEY are provided, client-side mTLS is enabled.
 * DB_SSL=true verifies the server certificate with the system CAs.
 * DB_SSL_REJECT_UNAUTHORIZED=false turns that check off and logs a warning.
 */
export function buildPgSslConfig(config: Record<string, string | undefined>): TlsOptions | undefined {
  if (config.DB_SSL !== 'true') {
    return undefined;
  }

  const caPath = config.DB_SSL_CA;
  const certPath = config.DB_SSL_CERT;
  const keyPath = config.DB_SSL_KEY;
  const rejectUnauthorizedRaw = config.DB_SSL_REJECT_UNAUTHORIZED;

  // If CA cert is provided, enable full certificate verification.
  // CA read failure is fatal — silent fallback to insecure mode is a security risk.
  const ca = caPath ? readFileSafe(caPath, true) : undefined;
  const cert = certPath ? readFileSafe(certPath, true) : undefined;
  const key = keyPath ? readFileSafe(keyPath, true) : undefined;

  const rejectUnauthorized = rejectUnauthorizedRaw !== 'false';
  if (rejectUnauthorizedRaw === 'false') {
    console.warn('[pg-ssl] certificate verification is off because DB_SSL_REJECT_UNAUTHORIZED=false');
  }

  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
  };
}

function readFileSafe(filePath: string, required: boolean): string | undefined {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (required) {
      throw new Error(`[pg-ssl] Failed to read required SSL file: ${filePath} — ${err instanceof Error ? err.message : String(err)}`);
    }
    console.warn(`[pg-ssl] Failed to read SSL file: ${filePath}`);
    return undefined;
  }
}
