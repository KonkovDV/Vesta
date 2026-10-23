/**
 * SecurityHeadersMiddleware - Security headers middleware
 * Layer: Application
 *
 * Provides comprehensive security headers including:
 * - HSTS (HTTP Strict Transport Security)
 * - X-Frame-Options (clickjacking protection)
 * - X-Content-Type-Options (MIME sniffing protection)
 * - Referrer-Policy
 * - Permissions-Policy
 * - CSP headers via CSPManager
 *
 * @example
 * ```typescript
 * const securityHeaders = new SecurityHeadersMiddleware({
 *   hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
 *   cspManager: cspManager
 * });
 *
 * app.use(securityHeaders.middleware());
 * ```
 */

import type * as core from 'express-serve-static-core';
import type { ILogger } from '../../core/decorators/ILogger';
import type { ICSPManager } from '../../core/http/ICSPManager';

export type { ICSPManager } from '../../core/http/ICSPManager';

/**
 * HSTS configuration
 */
export interface HstsConfig {
  /** Max age in seconds (default: 1 year) */
  maxAge?: number;
  /** Include subdomains */
  includeSubDomains?: boolean;
  /** Preload in browsers */
  preload?: boolean;
}

/**
 * Permissions Policy configuration
 */
export interface PermissionsPolicyConfig {
  /** Camera access */
  camera?: string;
  /** Microphone access */
  microphone?: string;
  /** Geolocation */
  geolocation?: string;
  /** Notifications */
  notifications?: string;
  /** Push notifications */
  push?: string;
  /** Fullscreen */
  fullscreen?: string;
  /** Payment */
  payment?: string;
  /** USB access */
  usb?: string;
  /** Magnetometer */
  magnetometer?: string;
  /** Gyroscope */
  gyroscope?: string;
  /** Accelerometer */
  accelerometer?: string;
  /** Ambient light sensor */
  'ambient-light-sensor'?: string;
  /** Autoplay */
  autoplay?: string;
  /** Encrypted media */
  encryptedMedia?: string;
  /** Picture-in-picture */
  pictureInPicture?: string;
  /** Screen wake lock */
  screenWakeLock?: string;
  /** Web share */
  webShare?: string;
  /** Gamepad */
  gamepad?: string;
  /** Speaker selection */
  speakerSelection?: string;
  /** Display capture */
  displayCapture?: string;
  /** Idle detection */
  idleDetection?: string;
  /** Storage access */
  storageAccess?: string;
  /** Window management */
  windowManagement?: string;
}

/**
 * Security headers configuration
 */
export interface SecurityHeadersConfig {
  /** HSTS configuration */
  hsts?: HstsConfig | boolean;
  /** X-Frame-Options value */
  frameOptions?: 'DENY' | 'SAMEORIGIN' | 'ALLOW-FROM' | false;
  /** X-Content-Type-Options */
  contentTypeOptions?: boolean;
  /** X-XSS-Protection */
  xssProtection?: boolean | string;
  /** Referrer-Policy */
  referrerPolicy?:
    | 'no-referrer'
    | 'no-referrer-when-downgrade'
    | 'origin'
    | 'origin-when-cross-origin'
    | 'same-origin'
    | 'strict-origin'
    | 'strict-origin-when-cross-origin'
    | 'unsafe-url'
    | false;
  /** Permissions-Policy */
  permissionsPolicy?: PermissionsPolicyConfig | false;
  /** Cross-Origin-Embedder-Policy */
  coep?: 'require-corp' | 'credentialless' | 'unsafe-none' | false;
  /** Cross-Origin-Opener-Policy */
  coop?: 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none' | false;
  /** Cross-Origin-Resource-Policy */
  corp?: 'same-site' | 'same-origin' | 'cross-origin' | false;
  /** CSP Manager instance */
  cspManager?: ICSPManager;
  /** Enable report-only mode for CSP */
  cspReportOnly?: boolean;
  /** Routes to exclude from security headers */
  excludeRoutes?: string[];
  /** Enable logging */
  enableLogging?: boolean;
}

/**
 * SecurityHeadersMiddleware - Applies security headers to responses
 */
export class SecurityHeadersMiddleware {
  private readonly config: Required<SecurityHeadersConfig>;
  private readonly logger?: ILogger;

  /**
   * Default security headers configuration
   */
  static readonly DEFAULT_CONFIG: Required<SecurityHeadersConfig> = {
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: false,
    },
    frameOptions: 'DENY',
    contentTypeOptions: true,
    xssProtection: false, // Disabled as CSP is preferred
    referrerPolicy: 'strict-origin-when-cross-origin',
    permissionsPolicy: {
      camera: "'none'",
      microphone: "'none'",
      geolocation: "'none'",
      notifications: "'self'",
      push: "'self'",
      fullscreen: "'self'",
      payment: "'none'",
      usb: "'none'",
      magnetometer: "'none'",
      gyroscope: "'none'",
      accelerometer: "'none'",
      'ambient-light-sensor': "'none'",
      autoplay: "'self'",
      encryptedMedia: "'none'",
      pictureInPicture: "'self'",
      screenWakeLock: "'none'",
      webShare: "'self'",
      gamepad: "'none'",
      speakerSelection: "'none'",
      displayCapture: "'none'",
      idleDetection: "'none'",
      storageAccess: "'none'",
      windowManagement: "'none'",
    },
    coep: false,
    coop: 'same-origin',
    corp: 'cross-origin',
    cspManager: undefined as unknown as ICSPManager,
    cspReportOnly: false,
    excludeRoutes: ['/health', '/metrics', '/ready'],
    enableLogging: false,
  };

  constructor(config: SecurityHeadersConfig = {}, logger?: ILogger) {
    this.config = this.mergeConfig(config);
    this.logger = logger;
  }

  /**
   * Get Express middleware
   */
  middleware(): (req: core.Request, res: core.Response, next: core.NextFunction) => void {
    return (req: core.Request, res: core.Response, next: core.NextFunction): void => {
      // Skip excluded routes
      if (this.shouldSkip(req)) {
        next();
        return;
      }

      // Apply HSTS
      if (this.config.hsts !== false) {
        this.applyHsts(res);
      }

      // Apply X-Frame-Options
      if (this.config.frameOptions !== false) {
        res.setHeader('X-Frame-Options', this.config.frameOptions);
      }

      // Apply X-Content-Type-Options
      if (this.config.contentTypeOptions) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
      }

      // Apply X-XSS-Protection (legacy)
      if (this.config.xssProtection !== false) {
        const value = typeof this.config.xssProtection === 'string'
          ? this.config.xssProtection
          : '0';
        res.setHeader('X-XSS-Protection', value);
      }

      // Apply Referrer-Policy
      if (this.config.referrerPolicy !== false) {
        res.setHeader('Referrer-Policy', this.config.referrerPolicy);
      }

      // Apply Permissions-Policy
      if (this.config.permissionsPolicy !== false) {
        this.applyPermissionsPolicy(res);
      }

      // Apply COOP
      if (this.config.coop !== false) {
        res.setHeader('Cross-Origin-Opener-Policy', this.config.coop);
      }

      // Apply COEP
      if (this.config.coep !== false) {
        res.setHeader('Cross-Origin-Embedder-Policy', this.config.coep);
      }

      // Apply CORP
      if (this.config.corp !== false) {
        res.setHeader('Cross-Origin-Resource-Policy', this.config.corp);
      }

      // Log security headers applied
      this.log('debug', 'security_headers_applied', {
        path: req.path,
        headers: this.getAppliedHeaders(),
      });

      next();
    };
  }

  /**
   * Apply CSP middleware (separate from other headers)
   */
  cspMiddleware(): (req: core.Request, res: core.Response, next: core.NextFunction) => void {
    if (!this.config.cspManager) {
      // Return no-op if no CSP manager configured
      return (_req: core.Request, _res: core.Response, next: core.NextFunction): void => {
        next();
      };
    }

    return this.config.cspManager.middleware();
  }

  /**
   * Combined middleware (all security headers + CSP)
   */
  combinedMiddleware(): (req: core.Request, res: core.Response, next: core.NextFunction) => void {
    const headersMiddleware = this.middleware();
    const cspMiddleware = this.cspMiddleware();

    return (req: core.Request, res: core.Response, next: core.NextFunction): void => {
      headersMiddleware(req, res, (err?: unknown): void => {
        if (err) {
          next(err);
          return;
        }
        cspMiddleware(req, res, next);
      });
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): SecurityHeadersConfig {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(updates: Partial<SecurityHeadersConfig>): void {
    this.config.hsts = updates.hsts ?? this.config.hsts;
    this.config.frameOptions = updates.frameOptions ?? this.config.frameOptions;
    this.config.contentTypeOptions = updates.contentTypeOptions ?? this.config.contentTypeOptions;
    this.config.xssProtection = updates.xssProtection ?? this.config.xssProtection;
    this.config.referrerPolicy = updates.referrerPolicy ?? this.config.referrerPolicy;
    this.config.permissionsPolicy = updates.permissionsPolicy ?? this.config.permissionsPolicy;
    this.config.coep = updates.coep ?? this.config.coep;
    this.config.coop = updates.coop ?? this.config.coop;
    this.config.corp = updates.corp ?? this.config.corp;
    this.config.excludeRoutes = updates.excludeRoutes ?? this.config.excludeRoutes;
    this.config.enableLogging = updates.enableLogging ?? this.config.enableLogging;

    this.log('info', 'security_headers_config_updated', updates);
  }

  /**
   * Apply HSTS header
   */
  private applyHsts(res: core.Response): void {
    const hsts = this.config.hsts;
    if (hsts === false || hsts === true) return;

    let value = 'max-age=' + String(hsts.maxAge ?? 0);

    if (hsts.includeSubDomains) {
      value += '; includeSubDomains';
    }

    if (hsts.preload) {
      value += '; preload';
    }

    res.setHeader('Strict-Transport-Security', value);
  }

  /**
   * Apply Permissions-Policy header
   */
  private applyPermissionsPolicy(res: core.Response): void {
    const policy = this.config.permissionsPolicy;
    if (policy === false) return;

    const directives: string[] = [];

    const directiveMap: Record<string, string | undefined> = {
      camera: policy.camera,
      microphone: policy.microphone,
      geolocation: policy.geolocation,
      notifications: policy.notifications,
      push: policy.push,
      fullscreen: policy.fullscreen,
      payment: policy.payment,
      usb: policy.usb,
      magnetometer: policy.magnetometer,
      gyroscope: policy.gyroscope,
      accelerometer: policy.accelerometer,
      'ambient-light-sensor': policy['ambient-light-sensor'],
      autoplay: policy.autoplay,
      'encrypted-media': policy.encryptedMedia,
      'picture-in-picture': policy.pictureInPicture,
      'screen-wake-lock': policy.screenWakeLock,
      'web-share': policy.webShare,
      gamepad: policy.gamepad,
      'speaker-selection': policy.speakerSelection,
      'display-capture': policy.displayCapture,
      'idle-detection': policy.idleDetection,
      'storage-access': policy.storageAccess,
      'window-management': policy.windowManagement,
    };

    for (const [key, value] of Object.entries(directiveMap)) {
      if (value !== undefined) {
        directives.push(`${key}=${value}`);
      }
    }

    if (directives.length > 0) {
      res.setHeader('Permissions-Policy', directives.join(', '));
    }
  }

  /**
   * Check if request should skip security headers
   */
  private shouldSkip(req: core.Request): boolean {
    const path = req.path || req.url;
    return this.config.excludeRoutes.some((route) => path.startsWith(route));
  }

  /**
   * Get list of applied headers for logging
   */
  private getAppliedHeaders(): string[] {
    const headers: string[] = [];

    if (this.config.hsts !== false) headers.push('Strict-Transport-Security');
    if (this.config.frameOptions !== false) headers.push('X-Frame-Options');
    if (this.config.contentTypeOptions) headers.push('X-Content-Type-Options');
    if (this.config.xssProtection !== false) headers.push('X-XSS-Protection');
    if (this.config.referrerPolicy !== false) headers.push('Referrer-Policy');
    if (this.config.permissionsPolicy !== false) headers.push('Permissions-Policy');
    if (this.config.coop !== false) headers.push('Cross-Origin-Opener-Policy');
    if (this.config.coep !== false) headers.push('Cross-Origin-Embedder-Policy');
    if (this.config.corp !== false) headers.push('Cross-Origin-Resource-Policy');
    if (this.config.cspManager) headers.push('Content-Security-Policy');

    return headers;
  }

  /**
   * Log if enabled
   */
  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (!this.config.enableLogging || !this.logger) {
      return;
    }

    const logMethod = this.logger[level];
    if (typeof logMethod === 'function') {
      logMethod.call(this.logger, message, meta);
    }
  }

  /**
   * Merge user config with defaults
   */
  private mergeConfig(userConfig: SecurityHeadersConfig): Required<SecurityHeadersConfig> {
    const merged: Required<SecurityHeadersConfig> = {
      ...SecurityHeadersMiddleware.DEFAULT_CONFIG,
    };

    if (userConfig.hsts !== undefined) {
      merged.hsts = userConfig.hsts === true
        ? SecurityHeadersMiddleware.DEFAULT_CONFIG.hsts
        : userConfig.hsts;
    }

    if (userConfig.frameOptions !== undefined) {
      merged.frameOptions = userConfig.frameOptions;
    }

    if (userConfig.contentTypeOptions !== undefined) {
      merged.contentTypeOptions = userConfig.contentTypeOptions;
    }

    if (userConfig.xssProtection !== undefined) {
      merged.xssProtection = userConfig.xssProtection;
    }

    if (userConfig.referrerPolicy !== undefined) {
      merged.referrerPolicy = userConfig.referrerPolicy;
    }

    if (userConfig.permissionsPolicy !== undefined) {
      merged.permissionsPolicy = userConfig.permissionsPolicy === false
        ? false
        : { ...SecurityHeadersMiddleware.DEFAULT_CONFIG.permissionsPolicy, ...userConfig.permissionsPolicy };
    }

    if (userConfig.coep !== undefined) {
      merged.coep = userConfig.coep;
    }

    if (userConfig.coop !== undefined) {
      merged.coop = userConfig.coop;
    }

    if (userConfig.corp !== undefined) {
      merged.corp = userConfig.corp;
    }

    if (userConfig.cspManager !== undefined) {
      merged.cspManager = userConfig.cspManager;
    }

    if (userConfig.cspReportOnly !== undefined) {
      merged.cspReportOnly = userConfig.cspReportOnly;
    }

    if (userConfig.excludeRoutes !== undefined) {
      merged.excludeRoutes = userConfig.excludeRoutes;
    }

    if (userConfig.enableLogging !== undefined) {
      merged.enableLogging = userConfig.enableLogging;
    }

    return merged;
  }
}

/**
 * Create default security headers middleware
 */
export function createSecurityHeadersMiddleware(
  config?: SecurityHeadersConfig,
  logger?: ILogger
): SecurityHeadersMiddleware {
  return new SecurityHeadersMiddleware(config, logger);
}
