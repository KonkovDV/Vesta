/**
 * CSPManager - Content Security Policy Manager
 * Layer: Infrastructure
 *
 * Provides strict CSP headers, nonce generation for inline scripts,
 * violation reporting, and policy configuration per route.
 *
 * @example
 * ```typescript
 * const cspManager = new CSPManager({
 *   defaultSrc: ["'self'"],
 *   scriptSrc: ["'self'", (req, nonce) => `'nonce-${nonce}'`],
 *   reportUri: '/api/csp-report'
 * });
 *
 * app.use(cspManager.middleware());
 * ```
 */

import { randomBytes } from 'crypto';
import type * as core from 'express-serve-static-core';
import type { ICSPManager } from '../../core/http/ICSPManager';

/**
 * CSP directive names
 */
export type CspDirective =
  | 'default-src'
  | 'script-src'
  | 'style-src'
  | 'img-src'
  | 'font-src'
  | 'connect-src'
  | 'media-src'
  | 'object-src'
  | 'frame-src'
  | 'frame-ancestors'
  | 'form-action'
  | 'base-uri'
  | 'manifest-src'
  | 'worker-src'
  | 'upgrade-insecure-requests'
  | 'block-all-mixed-content'
  | 'report-uri'
  | 'report-to';

/**
 * CSP source value
 */
export type CspSource = string | ((req: core.Request, nonce: string) => string);

/**
 * CSP policy configuration
 */
export interface CspPolicyConfig {
  /** Default sources for all directives */
  defaultSrc?: CspSource[];
  /** Script sources */
  scriptSrc?: CspSource[];
  /** Style sources */
  styleSrc?: CspSource[];
  /** Image sources */
  imgSrc?: CspSource[];
  /** Font sources */
  fontSrc?: CspSource[];
  /** Connection endpoints (XHR, WebSocket, EventSource) */
  connectSrc?: CspSource[];
  /** Media sources (video, audio) */
  mediaSrc?: CspSource[];
  /** Plugin sources (flash, etc) */
  objectSrc?: CspSource[];
  /** Frame sources */
  frameSrc?: CspSource[];
  /** Frame ancestors (clickjacking protection) */
  frameAncestors?: CspSource[];
  /** Form submission targets */
  formAction?: CspSource[];
  /** Base URI for relative URLs */
  baseUri?: CspSource[];
  /** Web app manifest sources */
  manifestSrc?: CspSource[];
  /** Worker and service worker sources */
  workerSrc?: CspSource[];
  /** Upgrade insecure requests */
  upgradeInsecureRequests?: boolean;
  /** Block all mixed content */
  blockAllMixedContent?: boolean;
  /** CSP violation report URI */
  reportUri?: string;
  /** CSP violation report-to group */
  reportTo?: string;
}

/**
 * CSP violation report
 */
export interface CspViolationReport {
  /** Document URI where violation occurred */
  'document-uri': string;
  /** Referrer */
  referrer: string;
  /** Blocked URI (the resource that violated policy) */
  'blocked-uri': string;
  /** Effective directive that was violated */
  'effective-directive': string;
  /** Original policy string */
  'original-policy': string;
  /** Violated directive */
  'violated-directive': string;
  /** Source file (if available) */
  'source-file'?: string;
  /** Line number */
  'line-number'?: number;
  /** Column number */
  'column-number'?: number;
  /** Status code */
  'status-code'?: number;
  /** Sample (for script/style violations) */
  sample?: string;
}

/**
 * CSP report payload
 */
export interface CspReportPayload {
  'csp-report': CspViolationReport;
}

/**
 * CSP middleware options
 */
export interface CspMiddlewareOptions {
  /** Policy configuration */
  policy?: CspPolicyConfig;
  /** Enable report-only mode (doesn't block, just reports) */
  reportOnly?: boolean;
  /** Custom nonce generator */
  nonceGenerator?: () => string;
  /** Violation report handler */
  onViolation?: (report: CspViolationReport, req: core.Request) => void | Promise<void>;
  /** Routes to exclude from CSP (e.g., health checks) */
  excludeRoutes?: string[];
}

/**
 * CSP violation statistics
 */
export interface CspViolationStats {
  totalViolations: number;
  violationsByDirective: Map<string, number>;
  violationsByBlockedUri: Map<string, number>;
  lastViolationAt?: Date;
}

/**
 * CSPManager - Manages Content Security Policy.
 * Implements the core ICSPManager port.
 */
export class CSPManager implements ICSPManager {
  private readonly config: Required<CspPolicyConfig>;
  private readonly reportOnly: boolean;
  private readonly nonceGenerator: () => string;
  private readonly onViolation?: (report: CspViolationReport, req: core.Request) => void | Promise<void>;
  private readonly excludeRoutes: string[];
  private violationStats: CspViolationStats;

  /**
   * Default CSP policy - strict security
   */
  static readonly DEFAULT_POLICY: Required<CspPolicyConfig> = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'],
    fontSrc: ["'self'"],
    connectSrc: ["'self'"],
    mediaSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameSrc: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    baseUri: ["'self'"],
    manifestSrc: ["'self'"],
    workerSrc: ["'self'"],
    upgradeInsecureRequests: true,
    blockAllMixedContent: true,
    reportUri: '/api/security/csp-report',
    reportTo: 'csp-endpoint',
  };

  /**
   * Permissive CSP policy for development
   */
  static readonly DEVELOPMENT_POLICY: Required<CspPolicyConfig> = {
    defaultSrc: ["'self'", '*'],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", '*'],
    styleSrc: ["'self'", "'unsafe-inline'", '*'],
    imgSrc: ["'self'", 'data:', 'blob:', '*'],
    fontSrc: ["'self'", '*'],
    connectSrc: ["'self'", '*'],
    mediaSrc: ["'self'", '*'],
    objectSrc: ["'none'"],
    frameSrc: ["'self'"],
    frameAncestors: ["'self'"],
    formAction: ["'self'"],
    baseUri: ["'self'"],
    manifestSrc: ["'self'"],
    workerSrc: ["'self'", 'blob:'],
    upgradeInsecureRequests: false,
    blockAllMixedContent: false,
    reportUri: '/api/security/csp-report',
    reportTo: 'csp-endpoint',
  };

  constructor(options: CspMiddlewareOptions = {}) {
    this.config = this.mergePolicy(options.policy ?? {});
    this.reportOnly = options.reportOnly ?? false;
    this.nonceGenerator = options.nonceGenerator ?? this.defaultNonceGenerator;
    this.onViolation = options.onViolation;
    this.excludeRoutes = options.excludeRoutes ?? ['/health', '/metrics', '/ready'];
    this.violationStats = {
      totalViolations: 0,
      violationsByDirective: new Map(),
      violationsByBlockedUri: new Map(),
    };
  }

  /**
   * Generate middleware for Express
   */
  middleware(): (req: core.Request, res: core.Response, next: core.NextFunction) => void {
    return (req: core.Request, res: core.Response, next: core.NextFunction): void => {
      // Skip excluded routes
      if (this.shouldSkip(req)) {
        next();
        return;
      }

      // Generate nonce for this request
      const nonce = this.nonceGenerator();
      (req as core.Request & { cspNonce?: string }).cspNonce = nonce;

      // Build and set CSP header
      const cspHeader = this.buildCspHeaderInternal(req, nonce);
      const headerName = this.reportOnly
        ? 'Content-Security-Policy-Report-Only'
        : 'Content-Security-Policy';

      res.setHeader(headerName, cspHeader);

      // Set Report-To header for modern browsers
      if (this.config.reportTo) {
        res.setHeader(
          'Report-To',
          JSON.stringify({
            group: this.config.reportTo,
            max_age: 31536000,
            endpoints: [{ url: this.config.reportUri }],
          })
        );
      }

      next();
    };
  }

  /**
   * Handle CSP violation report
   */
  async handleViolationReport(req: core.Request): Promise<void> {
    const payload = req.body as CspReportPayload;
    const report = payload?.['csp-report'];

    if (!report) {
      return;
    }

    // Update statistics
    this.violationStats.totalViolations++;
    this.violationStats.lastViolationAt = new Date();

    const directive = report['effective-directive'] || report['violated-directive'];
    const blockedUri = report['blocked-uri'];

    if (directive) {
      const count = this.violationStats.violationsByDirective.get(directive) ?? 0;
      this.violationStats.violationsByDirective.set(directive, count + 1);
    }

    if (blockedUri) {
      const count = this.violationStats.violationsByBlockedUri.get(blockedUri) ?? 0;
      this.violationStats.violationsByBlockedUri.set(blockedUri, count + 1);
    }

    // Call custom handler if provided
    if (this.onViolation) {
      await this.onViolation(report, req);
    }
  }

  /**
   * Get violation statistics
   */
  getViolationStats(): CspViolationStats {
    return {
      totalViolations: this.violationStats.totalViolations,
      violationsByDirective: new Map(this.violationStats.violationsByDirective),
      violationsByBlockedUri: new Map(this.violationStats.violationsByBlockedUri),
      lastViolationAt: this.violationStats.lastViolationAt,
    };
  }

  /**
   * Reset violation statistics
   */
  resetStats(): void {
    this.violationStats = {
      totalViolations: 0,
      violationsByDirective: new Map(),
      violationsByBlockedUri: new Map(),
    };
  }

  /**
   * Generate a nonce for inline scripts
   * Implements ICSPManager interface
   */
  generateNonce(): string {
    return this.nonceGenerator();
  }

  /**
   * Build CSP header value for a request
   * Implements ICSPManager interface
   */
  buildCSPHeader(req: core.Request, nonce: string): string {
    return this.buildCspHeaderInternal(req, nonce);
  }

  /**
   * Build CSP header string (internal implementation)
   */
  private buildCspHeaderInternal(req: core.Request, nonce: string): string {
    const directives: string[] = [];

    const directiveMap: Record<string, CspSource[] | undefined | boolean> = {
      'default-src': this.config.defaultSrc,
      'script-src': this.config.scriptSrc,
      'style-src': this.config.styleSrc,
      'img-src': this.config.imgSrc,
      'font-src': this.config.fontSrc,
      'connect-src': this.config.connectSrc,
      'media-src': this.config.mediaSrc,
      'object-src': this.config.objectSrc,
      'frame-src': this.config.frameSrc,
      'frame-ancestors': this.config.frameAncestors,
      'form-action': this.config.formAction,
      'base-uri': this.config.baseUri,
      'manifest-src': this.config.manifestSrc,
      'worker-src': this.config.workerSrc,
      'upgrade-insecure-requests': this.config.upgradeInsecureRequests,
      'block-all-mixed-content': this.config.blockAllMixedContent,
      'report-uri': this.config.reportUri ? [this.config.reportUri] : undefined,
      'report-to': this.config.reportTo ? [this.config.reportTo] : undefined,
    };

    for (const [name, value] of Object.entries(directiveMap)) {
      if (value === undefined) continue;

      if (typeof value === 'boolean') {
        if (value) {
          directives.push(name);
        }
        continue;
      }

      if (Array.isArray(value) && value.length > 0) {
        const resolved = value.map((src) =>
          typeof src === 'function' ? src(req, nonce) : src
        );
        directives.push(`${name} ${resolved.join(' ')}`);
      }
    }

    return directives.join('; ');
  }

  /**
   * Check if request should skip CSP
   */
  private shouldSkip(req: core.Request): boolean {
    const path = req.path || req.url;
    return this.excludeRoutes.some((route) => path.startsWith(route));
  }

  /**
   * Default nonce generator using crypto
   */
  private defaultNonceGenerator(): string {
    return randomBytes(16).toString('base64url');
  }

  /**
   * Merge user policy with defaults
   */
  private mergePolicy(userPolicy: CspPolicyConfig): Required<CspPolicyConfig> {
    return {
      ...CSPManager.DEFAULT_POLICY,
      ...userPolicy,
    };
  }
}

/**
 * Express middleware to extract CSP nonce from request
 */
export function getCspNonce(req: core.Request): string | undefined {
  return (req as core.Request & { cspNonce?: string }).cspNonce;
}

/**
 * Create CSP report endpoint handler
 */
export function createCspReportHandler(
  cspManager: CSPManager
): (req: core.Request, res: core.Response) => Promise<void> {
  return async (req: core.Request, res: core.Response): Promise<void> => {
    try {
      await cspManager.handleViolationReport(req);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: 'Failed to process CSP report' });
    }
  };
}
