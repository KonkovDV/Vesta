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
import { BlockList, isIP } from 'node:net';
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

// ─── Special-purpose ranges ──────────────────────────────────────────────────

/**
 * IANA IPv4 / IPv6 special-purpose registries (RFC 6890 and updates): every range
 * that is not globally reachable, plus multicast. An address inside one of these
 * is refused unless allowedCidrs names it.
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0', 8, '0.0.0.0/8 (this network)'],
  ['10.0.0.0', 8, '10.0.0.0/8 (RFC 1918)'],
  ['100.64.0.0', 10, '100.64.0.0/10 (CGN, RFC 6598)'],
  ['127.0.0.0', 8, '127.0.0.0/8 (loopback)'],
  ['169.254.0.0', 16, '169.254.0.0/16 (link-local)'],
  ['172.16.0.0', 12, '172.16.0.0/12 (RFC 1918)'],
  ['192.0.0.0', 24, '192.0.0.0/24 (IETF protocol assignments)'],
  ['192.0.2.0', 24, '192.0.2.0/24 (TEST-NET-1)'],
  ['192.88.99.0', 24, '192.88.99.0/24 (6to4 relay anycast)'],
  ['192.168.0.0', 16, '192.168.0.0/16 (RFC 1918)'],
  ['198.18.0.0', 15, '198.18.0.0/15 (benchmarking)'],
  ['198.51.100.0', 24, '198.51.100.0/24 (TEST-NET-2)'],
  ['203.0.113.0', 24, '203.0.113.0/24 (TEST-NET-3)'],
  ['224.0.0.0', 4, '224.0.0.0/4 (multicast)'],
  ['240.0.0.0', 4, '240.0.0.0/4 (reserved, broadcast)'],
];

const BLOCKED_V6: ReadonlyArray<readonly [string, number, string]> = [
  ['::', 96, '::/96 (unspecified, loopback, IPv4-compatible)'],
  ['64:ff9b:1::', 48, '64:ff9b:1::/48 (local-use NAT64)'],
  ['100::', 64, '100::/64 (discard)'],
  ['2001::', 23, '2001::/23 (IETF protocol assignments, Teredo)'],
  ['2001:db8::', 32, '2001:db8::/32 (documentation)'],
  ['2002::', 16, '2002::/16 (6to4)'],
  ['3fff::', 20, '3fff::/20 (documentation)'],
  ['5f00::', 16, '5f00::/16 (SRv6 SIDs)'],
  ['fc00::', 7, 'fc00::/7 (unique-local)'],
  ['fe80::', 10, 'fe80::/10 (link-local)'],
  ['fec0::', 10, 'fec0::/10 (site-local, deprecated)'],
  ['ff00::', 8, 'ff00::/8 (multicast)'],
];

function compileRanges(
  ranges: ReadonlyArray<readonly [string, number, string]>,
  family: 'ipv4' | 'ipv6',
): ReadonlyArray<{ list: BlockList; label: string }> {
  return ranges.map(([network, prefix, label]) => {
    const list = new BlockList();
    list.addSubnet(network, prefix, family);
    return { list, label };
  });
}

const BLOCKED_V4_LISTS = compileRanges(BLOCKED_V4, 'ipv4');
const BLOCKED_V6_LISTS = compileRanges(BLOCKED_V6, 'ipv6');

/** Eight 16-bit words of an IPv6 address, or undefined when the text is not one. */
export function ipv6Words(address: string): number[] | undefined {
  let text = address.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (isIP(text) !== 6) return undefined;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const words = [...head, ...Array<string>(fill).fill('0'), ...rest].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : undefined;
}

/**
 * The IPv4 address an IPv6 address hands traffic to: IPv4-mapped (::ffff:0:0/96)
 * and the well-known NAT64 prefix (64:ff9b::/96). A socket to either reaches that
 * IPv4 host, so it is checked as IPv4.
 */
export function embeddedIpv4(words: readonly number[]): string | undefined {
  const zeros = (from: number, to: number) => words.slice(from, to).every((word) => word === 0);
  const mapped = zeros(0, 5) && words[5] === 0xffff;
  const nat64 = words[0] === 0x64 && words[1] === 0xff9b && zeros(2, 6);
  if (!mapped && !nat64) return undefined;
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join('.');
}

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
    return isIP(value) === 4;
  }

  private isIpv6(value: string): boolean {
    return isIP(value.replace(/^\[|\]$/g, '')) === 6;
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

    for (const range of BLOCKED_V4_LISTS) {
      if (range.list.check(ip, 'ipv4')) {
        throw new SsrfBlockedError(ip, `Address in private range: ${range.label}`);
      }
    }
  }

  /**
   * IPv6 is parsed into words, not matched as text: `[::ffff:127.0.0.1]` reaches
   * the parser as `::ffff:7f00:1`, and NAT64 or 6to4 forms carry an IPv4 target.
   */
  private validateIpv6(ip: string): void {
    const bare = ip.replace(/^\[|\]$/g, '').toLowerCase();
    const words = ipv6Words(bare);
    if (!words) {
      throw new SsrfBlockedError(ip, 'Invalid IPv6 address');
    }

    const target = embeddedIpv4(words);
    if (target) {
      this.validateIpv4(target);
      return;
    }

    const zone = bare.indexOf('%');
    const address = zone >= 0 ? bare.slice(0, zone) : bare;
    for (const range of BLOCKED_V6_LISTS) {
      if (range.list.check(address, 'ipv6')) {
        throw new SsrfBlockedError(ip, `IPv6 address in blocked range: ${range.label}`);
      }
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
