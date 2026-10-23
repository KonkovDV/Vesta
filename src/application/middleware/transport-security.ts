
import helmet from 'helmet';
import type { Application as Express } from 'express-serve-static-core';

/**
 * Transport security layer — Helmet + secure headers + Permissions-Policy.
 *
 * CSP: Strict policy without 'unsafe-inline'. Nonce-based CSP is handled
 * by security-headers.middleware.ts (ICSPManager) for routes needing inline scripts.
 *
 * CORS: Removed from here — consolidated into app.ts configurable CORS
 * via ALLOWED_ORIGINS env var to eliminate dual-setup conflicts.
 */
export function applyTransportSecurity(app: Express) {
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", "data:", "blob:"],
        'connect-src': ["'self'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    noSniff: true,
    frameguard: { action: 'deny' },
  }));

  // Permissions-Policy: restrict browser features (OWASP recommendation)
  app.use((_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()',
    );
    next();
  });
}
