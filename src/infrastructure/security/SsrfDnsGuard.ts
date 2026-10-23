/**
 * SsrfDnsGuard — DNS rebinding protection for HTTP fetches.
 *
 * Prevents SSRF attacks by validating resolved IP addresses against
 * private/reserved ranges before allowing HTTP connections.
 *
 * @layer Infrastructure
 * @phase 16 — Content Security Hardening (OpenClaw extraction)
 * @donor external/openclaw/src/infra/net/ssrf.ts (364L)
 * @see PLANS/04_BACKLOG/OPENCLAW_EXTRACTION_PLAN_V1.md — Phase 16
 */

import { SecurityError, ConfigurationError } from '../../domain/errors/DomainError';
import * as dns from 'node:dns';
import { promisify } from 'node:util';

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

// ─── Configuration ───────────────────────────────────────────────────────────

export interface SsrfGuardConfig {
  /** Additional allowed CIDRs (override for specific private ranges) */
  allowedCidrs: readonly string[];
  /** DNS resolution timeout in ms (default: 3000) */
  dnsTimeoutMs: number;
  /** Whether to block IPv6 addresses entirely (default: true for safety) */
  blockIpv6: boolean;
}

/**
 * SSRF metrics callback interface — avoids direct prom-client import (Rule #7).
 * Provide via constructor to enable metrics collection.
 */
export interface ISsrfMetrics {
  /** Called on every validation attempt with the result */
  onValidation(result: 'allowed' | 'blocked', hostname: string, rangeLabel?: string): void;
  /** Called on DNS resolution with duration in ms */
  onDnsResolution(durationMs: number, hostname: string): void;
}

const DEFAULT_CONFIG: SsrfGuardConfig = {
  allowedCidrs: [],
  dnsTimeoutMs: 3_000,
  blockIpv6: true,
};

/** Validate CIDR notation: 'x.x.x.x/N' where N ∈ [0,32] */
const CIDR_PATTERN = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;

// ─── Private IP Ranges (IPv4) ────────────────────────────────────────────────

/**
 * RFC 1918 + RFC 5737 + RFC 6598 + loopback + link-local private ranges.
 */
const PRIVATE_RANGES: readonly { prefix: number; mask: number; label: string }[] = [
  { prefix: 0x0A000000, mask: 0xFF000000, label: '10.0.0.0/8 (RFC 1918)' },     // 10.x.x.x
  { prefix: 0xAC100000, mask: 0xFFF00000, label: '172.16.0.0/12 (RFC 1918)' },   // 172.16-31.x.x
  { prefix: 0xC0A80000, mask: 0xFFFF0000, label: '192.168.0.0/16 (RFC 1918)' },  // 192.168.x.x
  { prefix: 0x7F000000, mask: 0xFF000000, label: '127.0.0.0/8 (loopback)' },     // 127.x.x.x
  { prefix: 0xA9FE0000, mask: 0xFFFF0000, label: '169.254.0.0/16 (link-local)' }, // 169.254.x.x
  { prefix: 0x00000000, mask: 0xFF000000, label: '0.0.0.0/8 (this network)' },   // 0.x.x.x
  { prefix: 0xC0000000, mask: 0xFFFFFFF8, label: '192.0.0.0/29 (IETF)' },       // 192.0.0.0-7
  { prefix: 0xC0000200, mask: 0xFFFFFF00, label: '192.0.2.0/24 (TEST-NET-1)' },  // RFC 5737
  { prefix: 0xC6336400, mask: 0xFFFFFF00, label: '198.51.100.0/24 (TEST-NET-2)' },
  { prefix: 0xCB007100, mask: 0xFFFFFF00, label: '203.0.113.0/24 (TEST-NET-3)' },
  { prefix: 0x64400000, mask: 0xFFC00000, label: '100.64.0.0/10 (CGN, RFC 6598)' },
  { prefix: 0xE0000000, mask: 0xF0000000, label: '224.0.0.0/4 (multicast)' },    // 224-239.x.x.x
  { prefix: 0xF0000000, mask: 0xF0000000, label: '240.0.0.0/4 (reserved)' },     // 240-255.x.x.x
];

// ─── Error Types ─────────────────────────────────────────────────────────────

export interface PinnedEndpoint {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  path: string;
  hostHeader: string;
  addresses: readonly string[];
}

export class SsrfBlockedError extends SecurityError {
  constructor(
    hostname: string,
    reason: string,
    options?: { correlationId?: string },
  ) {
    super(`SSRF blocked: "${hostname}" — ${reason}`, {
      correlationId: options?.correlationId,
      metadata: { hostname, reason },
    });
  }
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * SsrfDnsGuard — validates that a hostname resolves to a public IP address.
 *
 * Usage:
 * ```typescript
 * const guard = new SsrfDnsGuard();
 * await guard.validate('example.com');       // OK — public IP
 * await guard.validate('127.0.0.1');         // throws SsrfBlockedError
 * await guard.validate('internal.corp.lan'); // throws SsrfBlockedError
 * ```
 */
/** Max DNS cache entries (LRU eviction). */
const DNS_CACHE_MAX = 500;
/** DNS cache TTL in milliseconds (5 minutes). */
const DNS_CACHE_TTL_MS = 300_000;

export class SsrfDnsGuard {
  private readonly config: SsrfGuardConfig;
  private readonly metrics?: ISsrfMetrics;
  private readonly dnsCache = new Map<string, { addresses: string[]; expiresAt: number }>();

  constructor(config?: Partial<SsrfGuardConfig>, metrics?: ISsrfMetrics) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = metrics;

    // Validate allowedCidrs upfront — fail fast on invalid CIDR notation (MED-18)
    for (const cidr of this.config.allowedCidrs) {
      const m = CIDR_PATTERN.exec(cidr);
      if (!m) {
        throw new ConfigurationError(
          `Invalid CIDR notation in allowedCidrs: "${cidr}"`,
          { metadata: { cidr, field: 'allowedCidrs' } },
        );
      }
      const bits = parseInt(m[2], 10);
      if (bits > 32) {
        throw new ConfigurationError(
          `Invalid CIDR prefix length in allowedCidrs: "${cidr}" (max 32)`,
          { metadata: { cidr, prefixLength: bits, field: 'allowedCidrs' } },
        );
      }
      const octets = m[1].split('.').map(Number);
      if (octets.some((o) => o > 255)) {
        throw new ConfigurationError(
          `Invalid IP octets in allowedCidrs: "${cidr}"`,
          { metadata: { cidr, field: 'allowedCidrs' } },
        );
      }
    }
  }

  /**
   * Validate that a hostname/IP resolves to a safe (non-private) address.
   *
   * @param hostname - The hostname or IP to validate
   * @throws SsrfBlockedError if the address is private/reserved
   */
  async validate(hostname: string): Promise<void> {
    await this.pinHostname(hostname);
  }

  /**
   * Resolve and check a hostname, returning the addresses that passed.
   * Callers that open a socket must connect to these addresses (custom lookup)
   * instead of resolving the name again.
   */
  async pinHostname(hostname: string): Promise<readonly string[]> {
    // Check if it's a raw IP address
    if (this.isIpv4(hostname)) {
      try {
        this.validateIpv4(hostname);
        this.metrics?.onValidation('allowed', hostname);
      } catch (err) {
        this.metrics?.onValidation('blocked', hostname, err instanceof SsrfBlockedError ? err.message : undefined);
        throw err;
      }
      return [hostname];
    }

    if (this.isIpv6(hostname)) {
      if (this.config.blockIpv6) {
        this.metrics?.onValidation('blocked', hostname, 'ipv6_blocked');
        throw new SsrfBlockedError(hostname, 'IPv6 addresses are blocked');
      }
      // Even when IPv6 is allowed, block private/loopback/link-local ranges (OWASP SSRF)
      try {
        this.validateIpv6(hostname);
        this.metrics?.onValidation('allowed', hostname);
      } catch (err) {
        this.metrics?.onValidation('blocked', hostname, err instanceof SsrfBlockedError ? err.message : undefined);
        throw err;
      }
      return [hostname.replace(/^\[|\]$/g, '')];
    }

    // Resolve hostname to IP addresses (A + AAAA)
    const addresses = await this.resolveHostname(hostname);

    for (const addr of addresses) {
      if (this.isIpv6(addr) || addr.includes(':')) {
        if (this.config.blockIpv6) {
          this.metrics?.onValidation('blocked', hostname, 'ipv6_resolved');
          throw new SsrfBlockedError(hostname, `Resolved to blocked IPv6 address: ${addr}`);
        }
        try {
          this.validateIpv6(addr);
        } catch (err) {
          this.metrics?.onValidation('blocked', hostname, err instanceof SsrfBlockedError ? err.message : undefined);
          throw err;
        }
      } else {
        try {
          this.validateIpv4(addr);
        } catch (err) {
          this.metrics?.onValidation('blocked', hostname, err instanceof SsrfBlockedError ? err.message : undefined);
          throw err;
        }
      }
    }

    this.metrics?.onValidation('allowed', hostname);
    return addresses;
  }

  /**
   * Check a URL's hostname for SSRF safety.
   *
   * @param url - Full URL to validate
   * @throws SsrfBlockedError if the hostname resolves to a private address
   */
  async validateUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SsrfBlockedError(url, 'Invalid URL');
    }

    // Block non-HTTP protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new SsrfBlockedError(url, `Blocked protocol: ${parsed.protocol}`);
    }

    await this.validate(parsed.hostname);
  }

  /**
   * Validate a URL and return the socket target. The addresses are the ones
   * just checked; a later DNS answer must not be used for the connection.
   */
  async pinUrl(url: string): Promise<PinnedEndpoint> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SsrfBlockedError(url, 'Invalid URL');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new SsrfBlockedError(url, `Blocked protocol: ${parsed.protocol}`);
    }

    if (parsed.username.length > 0 || parsed.password.length > 0) {
      throw new SsrfBlockedError(parsed.hostname || url, 'URL credentials are blocked');
    }

    const addresses = await this.pinHostname(parsed.hostname);
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === 'https:'
        ? 443
        : 80;

    return {
      protocol: parsed.protocol as 'http:' | 'https:',
      hostname: parsed.hostname,
      port,
      path: `${parsed.pathname}${parsed.search}`,
      hostHeader: parsed.host,
      addresses,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private isIpv4(value: string): boolean {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
  }

  private isIpv6(value: string): boolean {
    // Must contain a colon but exclude hostname:port patterns (e.g., "example.com:8080")
    // A valid IPv6 address contains at least two colons OR starts/ends with brackets
    return (value.startsWith('[') && value.includes(']')) ||
      (value.includes(':') && (value.split(':').length > 2 || value === '::'));
  }

  private validateIpv4(ip: string): void {
    const numeric = this.ipToNumber(ip);
    if (numeric === undefined) {
      throw new SsrfBlockedError(ip, 'Invalid IPv4 address');
    }

    // Check against allowed CIDRs first
    for (const cidr of this.config.allowedCidrs) {
      if (this.isInCidr(numeric, cidr)) {
        return; // Explicitly allowed
      }
    }

    // Check against private ranges
    for (const range of PRIVATE_RANGES) {
      if (((numeric & range.mask) >>> 0) === range.prefix) {
        throw new SsrfBlockedError(ip, `Address in private range: ${range.label}`);
      }
    }
  }

  /**
   * Validate IPv6 address against private/reserved ranges.
   * OWASP SSRF: Block loopback, link-local, unique-local, and IPv4-mapped addresses.
   */
  private validateIpv6(ip: string): void {
    const normalized = ip.replace(/^\[|\]$/g, '').toLowerCase();

    // Loopback ::1
    if (normalized === '::1' || normalized === '0000:0000:0000:0000:0000:0000:0000:0001') {
      throw new SsrfBlockedError(ip, 'IPv6 loopback address (::1)');
    }

    // Unspecified :: (like 0.0.0.0)
    if (normalized === '::' || normalized === '0000:0000:0000:0000:0000:0000:0000:0000') {
      throw new SsrfBlockedError(ip, 'IPv6 unspecified address (::)');
    }

    // Link-local fe80::/10
    if (/^fe[89ab]/i.test(normalized)) {
      throw new SsrfBlockedError(ip, 'IPv6 link-local address (fe80::/10)');
    }

    // Unique local fc00::/7 (includes fd00::/8)
    if (/^f[cd]/i.test(normalized)) {
      throw new SsrfBlockedError(ip, 'IPv6 unique-local address (fc00::/7)');
    }

    // IPv4-mapped ::ffff:x.x.x.x — validate the embedded IPv4
    const v4MappedMatch = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4MappedMatch) {
      this.validateIpv4(v4MappedMatch[1]);
      return;
    }

    // Multicast ff00::/8
    if (normalized.startsWith('ff')) {
      throw new SsrfBlockedError(ip, 'IPv6 multicast address (ff00::/8)');
    }
  }

  private ipToNumber(ip: string): number | undefined {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return undefined;
    }
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  private isInCidr(ip: number, cidr: string): boolean {
    const [addr, bits] = cidr.split('/');
    const prefix = this.ipToNumber(addr);
    if (prefix === undefined || !bits) return false;
    const mask = (~0 << (32 - parseInt(bits, 10))) >>> 0;
    return (ip & mask) === (prefix & mask);
  }

  /**
   * Resolve hostname to IP addresses for SSRF validation.
   *
   * `validateUrl` alone still has a time-of-check gap: a later socket that
   * resolves the name again can receive a different address. `pinUrl` returns
   * the addresses from this check. `SsrfPinnedHttpClient` connects with a
   * custom lookup that returns only those addresses.
   *
   * @see OWASP SSRF Prevention Cheat Sheet — DNS pinning
   */
  private async resolveHostname(hostname: string): Promise<string[]> {
    // Check cache first (TTL-based, LRU eviction)
    const cached = this.dnsCache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.addresses;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SsrfBlockedError(hostname, 'DNS resolution timeout')),
        this.config.dnsTimeoutMs,
      );
    });

    const dnsStart = Date.now();
    try {
      // Resolve both A (IPv4) and AAAA (IPv6) records — OWASP SSRF prevention:
      // An attacker could register a hostname with only AAAA records pointing to ::1
      // to bypass IPv4-only checks.
      const [v4Addresses, v6Addresses] = await Promise.race([
        Promise.allSettled([
          dnsResolve4(hostname).catch(() => [] as string[]),
          dnsResolve6(hostname).catch(() => [] as string[]),
        ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : [] as string[])) as Promise<[string[], string[]]>,
        timeoutPromise,
      ]);

      const allAddresses = [...v4Addresses, ...v6Addresses];

      if (allAddresses.length === 0) {
        throw new SsrfBlockedError(hostname, 'DNS resolution returned no addresses');
      }

      this.metrics?.onDnsResolution(Date.now() - dnsStart, hostname);

      // Cache the result with TTL
      if (this.dnsCache.size >= DNS_CACHE_MAX) {
        const oldest = this.dnsCache.keys().next().value;
        if (oldest) this.dnsCache.delete(oldest);
      }
      this.dnsCache.set(hostname, { addresses: allAddresses, expiresAt: Date.now() + DNS_CACHE_TTL_MS });

      return allAddresses;
    } catch (err) {
      if (err instanceof SsrfBlockedError) throw err;
      throw new SsrfBlockedError(
        hostname,
        `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
