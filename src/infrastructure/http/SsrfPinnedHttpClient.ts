/**
 * HTTP GET that connects to the addresses already checked by SsrfDnsGuard.
 *
 * The socket lookup returns only those addresses, so a later DNS answer cannot
 * move the connection onto a private IP. Redirects are checked again. The body
 * is capped and the socket is destroyed past the cap.
 *
 * Ingestion uses it when the DNS guard is registered. It is not its own DI token.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

import {
  SsrfBlockedError,
  type PinnedEndpoint,
  type SsrfDnsGuard,
} from '../security/SsrfDnsGuard';

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class SsrfPinnedHttpError extends Error {
  constructor(
    readonly code: 'response_too_large' | 'timeout' | 'too_many_redirects' | 'redirect_blocked',
    message: string,
  ) {
    super(message);
    this.name = 'SsrfPinnedHttpError';
  }
}

export interface SsrfPinnedHttpClientOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

interface PinnedResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  stream: Readable;
  abort: () => void;
}

export function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  const records = addresses.map((address) => {
    const bare = address.replace(/^\[|\]$/g, '');
    const family: 4 | 6 = bare.includes(':') ? 6 : 4;
    return { address: bare, family };
  });

  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (records.length === 0) {
      const error = new Error('No pinned address') as NodeJS.ErrnoException;
      error.code = 'EINVAL';
      callback(error, '', 4);
      return;
    }
    if (options.all) {
      callback(null, records);
      return;
    }
    callback(null, records[0].address, records[0].family);
  };
  return lookup;
}

/**
 * Remote ingestion must connect through the pinned client when a guard exists.
 * A check followed by a normal HTTP client resolves DNS a second time.
 */
export interface PinnedExchangeOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PinnedExchangeResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * One HTTP exchange to the addresses `pinUrl` just checked.
 * A later DNS answer is not used for this socket.
 */
export async function pinnedExchange(
  guard: { pinUrl(url: string): Promise<PinnedEndpoint> },
  options: PinnedExchangeOptions,
): Promise<PinnedExchangeResult> {
  const pinned = await guard.pinUrl(options.url);
  const opened = await openPinnedSocket(
    pinned,
    options.method,
    options.headers ?? {},
    options.body,
    options.timeoutMs,
    options.signal,
  );
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of opened.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (error) {
    opened.abort();
    throw error;
  }
  return {
    statusCode: opened.statusCode,
    headers: opened.headers,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

/**
 * Fetch implementation whose sockets stay on the pinned addresses.
 * Redirects are checked again. `redirect: 'manual'` returns the redirect response.
 */
export function createPinnedFetch(guard: { pinUrl(url: string): Promise<PinnedEndpoint> }): typeof fetch {
  const redirectStatuses = new Set([301, 302, 303, 307, 308]);
  return async (input, init) => {
    let current = requestUrl(input);
    let method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body = bodyText(init?.body);
    const manual = init?.redirect === 'manual';
    for (let hop = 0; hop <= 3; hop += 1) {
      const pinned = await guard.pinUrl(current);
      const opened = await openPinnedSocket(
        pinned,
        method,
        headerRecord(init?.headers),
        body,
        30_000,
        init?.signal ?? undefined,
      );
      if (!redirectStatuses.has(opened.statusCode) || manual || hop === 3) {
        const stream = Readable.toWeb(opened.stream) as ReadableStream<Uint8Array>;
        return new Response(stream, { status: opened.statusCode, headers: headerPairs(opened.headers) });
      }
      const location = headerValue(opened.headers, 'location');
      opened.abort();
      if (!location) {
        throw new SsrfBlockedError(pinned.hostname, 'Redirect without Location');
      }
      const next = new URL(location, current);
      if (pinned.protocol === 'https:' && next.protocol === 'http:') {
        throw new SsrfBlockedError(next.hostname, 'Redirect from https to http is blocked');
      }
      current = next.href;
      if (opened.statusCode === 303 || ((opened.statusCode === 301 || opened.statusCode === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    }
    throw new SsrfBlockedError(current, 'Stopped after 3 redirects');
  };
}

function bodyText(body: BodyInit | null | undefined): string | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  const list = headers instanceof Headers
    ? Array.from(headers.entries())
    : Array.isArray(headers)
      ? headers
      : Object.entries(headers);
  for (const [name, value] of list) {
    record[name] = value;
  }
  return record;
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function headerPairs(headers: http.IncomingHttpHeaders): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') pairs.push([name, value]);
    else if (Array.isArray(value)) {
      for (const item of value) pairs.push([name, item]);
    }
  }
  return pairs;
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error('The operation was aborted');
}

function openPinnedSocket(
  pinned: PinnedEndpoint,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; stream: http.IncomingMessage; abort: () => void }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let settled = false;
    const lib = pinned.protocol === 'https:' ? https : http;
    let onAbort = (): void => undefined;
    const fail = (error: Error, req: http.ClientRequest) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      req.destroy();
      reject(error);
    };
    const req = lib.request(
      {
        protocol: pinned.protocol,
        hostname: pinned.hostname,
        port: pinned.port,
        path: pinned.path.length > 0 ? pinned.path : '/',
        method,
        headers: {
          ...headers,
          Host: pinned.hostHeader,
          'Accept-Encoding': 'identity',
        },
        lookup: createPinnedLookup(pinned.addresses),
        servername: pinned.hostname,
        timeout: timeoutMs,
      },
      (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          stream: res,
          abort: () => {
            res.on('error', () => undefined);
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.on('timeout', () => {
      fail(new SsrfPinnedHttpError('timeout', `Timed out after ${timeoutMs}ms`), req);
    });
    req.on('error', (error) => {
      fail(error instanceof Error ? error : new Error(String(error)), req);
    });
    onAbort = () => fail(abortError(signal), req);
    signal?.addEventListener('abort', onAbort);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export function selectIngestionHttpClient<T>(
  guard: SsrfDnsGuard | undefined,
  fallback: T | undefined,
): SsrfPinnedHttpClient | T | undefined {
  return guard ? new SsrfPinnedHttpClient(guard) : fallback;
}

export class SsrfPinnedHttpClient {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;

  constructor(
    private readonly guard: SsrfDnsGuard,
    options?: SsrfPinnedHttpClientOptions,
  ) {
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  }

  /**
   * GET `url`. `status` is the final HTTP status. `data` is the body.
   * Matches the ingestion client shape `{ data, status }`.
   */
  async get(url: string): Promise<{ status: number; data: Buffer }> {
    let current = url;
    let seenProtocol: 'http:' | 'https:' | undefined;
    const deadline = Date.now() + this.timeoutMs;

    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SsrfPinnedHttpError('timeout', `Timed out after ${this.timeoutMs}ms`);
      }

      const pinned = await this.guard.pinUrl(current);
      if (seenProtocol === 'https:' && pinned.protocol === 'http:') {
        throw new SsrfBlockedError(pinned.hostname, 'Redirect from https to http is blocked');
      }
      seenProtocol = pinned.protocol;

      const response = await this.request(pinned, remaining);
      if (!REDIRECT_STATUSES.has(response.statusCode)) {
        const data = await this.readLimited(response, remaining);
        return { status: response.statusCode, data };
      }

      response.abort();
      if (hop === this.maxRedirects) {
        throw new SsrfPinnedHttpError(
          'too_many_redirects',
          `Stopped after ${this.maxRedirects} redirects`,
        );
      }

      const location = response.headers.location;
      const next = typeof location === 'string'
        ? location
        : Array.isArray(location)
          ? location[0]
          : undefined;
      if (!next || next.trim().length === 0) {
        throw new SsrfPinnedHttpError('redirect_blocked', 'Redirect without Location');
      }
      current = new URL(next.trim(), current).href;
    }

    throw new SsrfPinnedHttpError(
      'too_many_redirects',
      `Stopped after ${this.maxRedirects} redirects`,
    );
  }

  private request(pinned: PinnedEndpoint, timeoutMs: number): Promise<PinnedResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const lib = pinned.protocol === 'https:' ? https : http;
      const fail = (error: Error, req: http.ClientRequest) => {
        if (settled) {
          return;
        }
        settled = true;
        req.destroy();
        reject(error);
      };

      const req = lib.request(
        {
          protocol: pinned.protocol,
          hostname: pinned.hostname,
          port: pinned.port,
          path: pinned.path.length > 0 ? pinned.path : '/',
          method: 'GET',
          headers: {
            Host: pinned.hostHeader,
            Accept: '*/*',
            'Accept-Encoding': 'identity',
          },
          lookup: createPinnedLookup(pinned.addresses),
          servername: pinned.hostname,
          timeout: timeoutMs,
        },
        (res) => {
          if (settled) {
            res.destroy();
            return;
          }
          settled = true;
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            stream: res,
            abort: () => {
              res.on('error', () => undefined);
              res.destroy();
              req.destroy();
            },
          });
        },
      );

      req.on('timeout', () => {
        fail(new SsrfPinnedHttpError('timeout', `Timed out after ${timeoutMs}ms`), req);
      });
      req.on('error', (error) => {
        fail(error instanceof Error ? error : new Error(String(error)), req);
      });
      req.end();
    });
  }

  private readLimited(response: PinnedResponse, timeoutMs: number): Promise<Buffer> {
    const { stream, abort } = response;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (error: Error | undefined, body?: Buffer) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (error) {
          abort();
          reject(error);
          return;
        }
        resolve(body ?? Buffer.alloc(0));
      };

      const fail = (error: Error) => finish(error);
      timer = setTimeout(() => {
        fail(new SsrfPinnedHttpError('timeout', `Timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      stream.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > this.maxBytes) {
          fail(new SsrfPinnedHttpError(
            'response_too_large',
            `Response exceeds ${this.maxBytes} bytes`,
          ));
          return;
        }
        chunks.push(buf);
      });
      stream.on('end', () => {
        finish(undefined, Buffer.concat(chunks));
      });
      stream.on('error', (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}
