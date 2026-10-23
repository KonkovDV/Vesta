/**
 * Qdrant/OpenMemory Vector HTTP client.
 *
 * Layer: Infrastructure
 *
 * This class implements the Memory-layer VectorClient interface over real HTTP
 * calls to a Qdrant/OpenMemory-compatible vector service. Behavior is
 * environment-sensitive:
 * - production validates configuration strictly and fails fast on invalid setup;
 * - non-production may fall back to development-safe defaults when config is absent.
 *
 * For MEM-M2.5 it also:
 * - validates configuration per environment;
 * - exposes a lightweight health check used by /healthz;
 * - wraps operations in observability metrics via monitoring facade.
 *
 * Relevant env variables (see openmemory-infra-plan.dev-stage-prod.md):
 * - OPENMEMORY_VECTOR_URL
 * - OPENMEMORY_VECTOR_API_KEY
 * - OPENMEMORY_VECTOR_TIMEOUT_MS (optional, ms)
 */
 
import * as http from 'http';
import * as https from 'https';
import { logger } from '../../logging/logger';
import { getConfig } from '../../../config';
import { safeParseInt } from '../../../core/config/safe-parse';
import { tryJsonParse } from '../../../core/utils/json';
import type {
  VectorClient,
  VectorUpsertInput,
  VectorSearchInput,
  VectorSearchResultItem,
} from '../../../domain/memory/session-memory-ports';
import type { VectorPointer } from '../../../domain/memory/session-types';
import { getOrCreateCounter, getOrCreateHistogram } from '../../../monitoring';
import { IdGenerator } from '../../../core/utils/IdGenerator';
 
type OpenMemoryEnvironment = 'production' | 'development' | 'test';
 
function resolveEnvironmentFromNodeEnv(): OpenMemoryEnvironment {
  const config = getConfig();
  const raw = config.NODE_ENV;
  if (raw === 'production') {
    return 'production';
  }
  if (raw === 'test') {
    return 'test';
  }
  return 'development';
}
 
const vectorRequestCounter = getOrCreateCounter(
  'openmemory_vector_requests_total',
  'Total requests performed by OpenMemory Vector client',
  ['operation', 'outcome'],
);
 
const vectorRequestDuration = getOrCreateHistogram(
  'openmemory_vector_request_duration_seconds',
  'Duration of OpenMemory Vector client requests in seconds',
  ['operation'],
);

interface QdrantHttpRequestOptions {
  method: 'GET' | 'POST';
  url: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface QdrantHttpResponse {
  statusCode: number;
  body: string;
}

type QdrantHttpRequestImpl = (options: QdrantHttpRequestOptions) => Promise<QdrantHttpResponse>;

function defaultQdrantHttpRequestImpl(
  options: QdrantHttpRequestOptions,
): Promise<QdrantHttpResponse> {
  return new Promise<QdrantHttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch (err) {
      return reject(err);
    }

    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request(
      {
        method: options.method,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: url.pathname + url.search,
        timeout: options.timeoutMs,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode, body });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`QdrantVectorClient HTTP timeout after ${options.timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (options.body != null) {
      const json = JSON.stringify(options.body);
      req.write(json);
    }

    req.end();
  });
}

export interface QdrantVectorClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  environment?: OpenMemoryEnvironment;
}
 
export class QdrantVectorClient implements VectorClient {
  private static httpRequestImpl: QdrantHttpRequestImpl = defaultQdrantHttpRequestImpl;

  private readonly log = logger.child({ component: 'QdrantVectorClient' });

  constructor(private readonly options: QdrantVectorClientOptions) {}

  /**
   * Allows tests to override the underlying HTTP transport without touching Node core modules.
   */
  static setHttpRequestImpl(impl: QdrantHttpRequestImpl): void {
    this.httpRequestImpl = impl;
  }

  /**
   * Restores the default Node.js http/https-based transport.
   */
  static resetHttpRequestImpl(): void {
    this.httpRequestImpl = defaultQdrantHttpRequestImpl;
  }

  private get httpRequest(): QdrantHttpRequestImpl {
    return QdrantVectorClient.httpRequestImpl;
  }

  private get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  private get environment(): OpenMemoryEnvironment {
    if (this.options.environment === 'production' || this.options.environment === 'test') {
      return this.options.environment;
    }
    return 'development';
  }

  private shouldUseNetwork(): boolean {
    return this.environment === 'production';
  }

  /**
   * Lightweight health probe used by monitoring.getOverallHealth() via DI.
   *
   * - In production: performs an HTTP GET to `${baseUrl}/health` with a timeout
   *   and returns true only on 2xx responses.
   * - In non-production environments: treats a valid configuration as healthy
   *   and avoids external network requirements for tests/dev.
   */
  async isHealthy(): Promise<boolean> {
    if (this.environment !== 'production') {
      return true;
    }

    try {
      const ok = await this.performHealthRequest();
      if (!ok) {
        this.log.warn('Qdrant/OpenMemory Vector health check reported unhealthy');
      }
      return ok;
    } catch (err) {
      const error = err as Error;
      this.log.error('Qdrant/OpenMemory Vector health check failed', { error: error.message });
      return false;
    }
  }

  private async performHealthRequest(): Promise<boolean> {
    const timeoutMs = this.options.timeoutMs ?? 5000;

    let healthUrl: string;
    try {
      const base = new URL(this.baseUrl);
      const full = new URL('/health', base);
      healthUrl = full.toString();
    } catch (err) {
      const error = err as Error;
      this.log.error('Invalid baseUrl for Qdrant/OpenMemory Vector health check', {
        error: error.message,
      });
      return false;
    }

    try {
      const headers = this.options.apiKey
        ? { Authorization: `Bearer ${this.options.apiKey}` }
        : undefined;

      const response = await this.httpRequest({
        method: 'GET',
        url: healthUrl,
        timeoutMs,
        headers,
      });

      const ok = response.statusCode >= 200 && response.statusCode < 300;
      return ok;
    } catch (err) {
      const error = err as Error;
      this.log.warn('Qdrant/OpenMemory Vector health check error', {
        error: error.message,
      });
      return false;
    }
  }

  private async postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
    const timeoutMs = this.options.timeoutMs ?? 5000;

    let url: string;
    try {
      const base = new URL(this.baseUrl);
      const full = new URL(path, base);
      url = full.toString();
    } catch (err) {
      const error = err as Error;
      this.log.error('Invalid baseUrl for Qdrant/OpenMemory Vector request', {
        error: error.message,
      });
      throw error;
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.options.apiKey) {
      headers.Authorization = `Bearer ${this.options.apiKey}`;
    }

    const response = await this.httpRequest({
      method: 'POST',
      url,
      timeoutMs,
      headers,
      body,
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      this.log.warn('Qdrant/OpenMemory Vector HTTP request failed', {
        statusCode: response.statusCode,
        body: response.body?.slice(0, 512),
      });
      throw new Error(
        `QdrantVectorClient: HTTP ${response.statusCode} response for ${path}`,
      );
    }

    if (!response.body) {
      return {} as TResponse;
    }

    const parsed = tryJsonParse<TResponse>(response.body);
    if (!parsed.ok) {
      const error = parsed.error;
      this.log.warn('Failed to parse Qdrant/OpenMemory Vector JSON response', {
        error: error.message,
      });
      throw error;
    }

    return parsed.value;
  }

  /**
   * Upsert a single vector into a Qdrant collection.
   *
   * In non-production environments this remains a pure stub without any network calls.
   */
  async upsertVector(input: VectorUpsertInput): Promise<VectorPointer> {
    const operation = 'upsert_vector';
    const endTimer = vectorRequestDuration.startTimer({ operation });

    try {
      const vectorId = IdGenerator.generateWithPrefix('vp');

      this.log.debug(
        this.shouldUseNetwork() ? 'upsertVector (http)' : 'upsertVector (stub)',
        {
          tenant_id: input.tenant_id,
          collection: input.collection,
          session_id: input.session_id,
          user_id: input.user_id,
          correlation_id: input.correlation_id,
        },
      );

      if (this.shouldUseNetwork()) {
        const payload = {
          ...input.payload,
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          session_id: input.session_id,
        };

        const body = {
          points: [
            {
              id: vectorId,
              vector: input.vector,
              payload,
            },
          ],
        };

        await this.postJson(`/collections/${encodeURIComponent(input.collection)}/points`, body);
      }

      const pointer: VectorPointer = {
        collection: input.collection,
        vector_id: vectorId,
        embedding_dim: input.vector.length,
      };

      vectorRequestCounter.labels({ operation, outcome: 'success' }).inc();
      return pointer;
    } catch (err) {
      vectorRequestCounter.labels({ operation, outcome: 'error' }).inc();
      throw err;
    } finally {
      endTimer();
    }
  }

  /**
   * Qdrant-specific bulk upsert helper matching the conceptual "upsertVectors" contract.
   * Delegates to the canonical upsertVector() method for now.
   */
  async upsertVectors(
    collection: string,
    inputs: Omit<VectorUpsertInput, 'collection'>[],
  ): Promise<VectorPointer[]> {
    const pointers: VectorPointer[] = [];
    for (const input of inputs) {
      const pointer = await this.upsertVector({ ...input, collection });
      pointers.push(pointer);
    }
    return pointers;
  }

  /**
   * Vector search over a Qdrant collection.
   *
   * In non-production environments this remains a pure stub without any network calls.
   */
  async search(input: VectorSearchInput): Promise<VectorSearchResultItem[]> {
    const operation = 'search';
    const endTimer = vectorRequestDuration.startTimer({ operation });

    try {
      this.log.debug(
        this.shouldUseNetwork() ? 'search (http)' : 'search (stub)',
        {
          tenant_id: input.tenant_id,
          collection: input.collection,
          user_id: input.user_id,
          session_id: input.session_id,
          limit: input.limit,
          correlation_id: input.correlation_id,
        },
      );

      if (!this.shouldUseNetwork()) {
        vectorRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return [];
      }

      const limit = input.limit ?? 10;
      const body: Record<string, unknown> = {
        vector: input.query_vector,
        limit,
        with_payload: true,
      };

      if (input.filters) {
        body.filter = input.filters;
      }

      interface QdrantSearchPoint {
        id: string | number;
        score: number;
        payload?: Record<string, unknown>;
        vector?: number[];
      }

      interface QdrantSearchResponse {
        result?: QdrantSearchPoint[];
      }

      const response = await this.postJson<QdrantSearchResponse>(
        `/collections/${encodeURIComponent(input.collection)}/points/search`,
        body,
      );

      const items = (response.result ?? []).map<VectorSearchResultItem>((item) => ({
        pointer: {
          collection: input.collection,
          vector_id: String(item.id),
          embedding_dim: Array.isArray(item.vector) ? item.vector.length : undefined,
        },
        score: item.score,
        payload: item.payload ?? {},
      }));

      vectorRequestCounter.labels({ operation, outcome: 'success' }).inc();
      return items;
    } catch (err) {
      vectorRequestCounter.labels({ operation, outcome: 'error' }).inc();
      throw err;
    } finally {
      endTimer();
    }
  }

  /**
   * Qdrant-specific helper matching the "queryVectors" conceptual contract.
   * Delegates to the canonical search() method.
   */
  async queryVectors(
    collection: string,
    queryVector: number[],
    topK: number,
    filters?: Record<string, unknown>,
  ): Promise<VectorSearchResultItem[]> {
    return this.search({
      tenant_id: 'unknown',
      collection,
      query_vector: queryVector,
      filters,
      limit: topK,
    });
  }
}
 
/**
 * Factory for DI: creates a QdrantVectorClient using environment variables.
 *
 * Defaults:
 * - baseUrl: OPENMEMORY_VECTOR_URL or dev fallback http://openmemory-vector.dev.internal:6333
 *
 * Behaviour:
 * - production: requires valid OPENMEMORY_VECTOR_URL, fails fast with clear error if missing/invalid;
 * - development: allows fallback dev URL with warnings;
 * - test: allows fallback dev URL without warnings because network is disabled.
 */
export function createQdrantVectorClientFromEnv(): VectorClient {
  const environment = resolveEnvironmentFromNodeEnv();
  const config = getConfig();
  const rawUrl = config.OPENMEMORY_VECTOR_URL;
  const fallbackDevUrl = 'http://openmemory-vector.dev.internal:6333';

  let baseUrl: string;

  if (environment === 'production') {
    if (!rawUrl || rawUrl.length === 0) {
      const message =
        'QdrantVectorClient: OPENMEMORY_VECTOR_URL is not configured for production';
      logger.error(message, { environment });
      throw new Error(message);
    }

    try {
      const parsed = new URL(rawUrl);
      baseUrl = parsed.toString();
    } catch (err) {
      const error = err as Error;
      const message =
        'QdrantVectorClient: OPENMEMORY_VECTOR_URL is invalid URL for production';
      logger.error(message, { environment, reason: error.message });
      throw new Error(message);
    }
  } else {
    if (!rawUrl || rawUrl.length === 0) {
      baseUrl = fallbackDevUrl;
      if (environment === 'development') {
        logger.warn(
          'OPENMEMORY_VECTOR_URL is not set; using dev fallback for Qdrant/OpenMemory Vector client',
          {
            baseUrl,
            environment,
          },
        );
      }
    } else {
      try {
        const parsed = new URL(rawUrl);
        baseUrl = parsed.toString();
      } catch (err) {
        const error = err as Error;
        baseUrl = fallbackDevUrl;
        if (environment === 'development') {
          logger.warn(
            'OPENMEMORY_VECTOR_URL is invalid; using dev fallback for Qdrant/OpenMemory Vector client',
            {
              environment,
              reason: error.message,
              baseUrl,
            },
          );
        }
      }
    }
  }

  const apiKey = config.OPENMEMORY_VECTOR_API_KEY;
  const timeoutFromEnv = config.OPENMEMORY_VECTOR_TIMEOUT_MS;
  const timeoutMs = safeParseInt(timeoutFromEnv, 5000);
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;

  if (environment === 'production' && (!apiKey || apiKey.length === 0)) {
    logger.warn(
      'QdrantVectorClient: OPENMEMORY_VECTOR_API_KEY is not set for production',
      {
        environment,
      },
    );
  }

  return new QdrantVectorClient({
    baseUrl,
    apiKey,
    timeoutMs: effectiveTimeoutMs,
    environment,
  });
}