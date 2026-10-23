/**
 * OpenMemory HSG client.
 *
 * Layer: Infrastructure
 *
 * This class implements the Memory-layer HSGClient interface. It is designed
 * to:
 * - read configuration from environment variables via config layer;
 * - perform real HTTP requests to OpenMemory HSG API in production;
 * - fall back to safe stub behaviour in non-production environments
 *   (development/test) to avoid external dependencies in local/CI runs;
 * - expose a lightweight health check used by /healthz;
 * - wrap operations in observability metrics via monitoring facade.
 *
 * Relevant env variables (see openmemory-infra-plan.dev-stage-prod.md):
 * - OPENMEMORY_HSG_URL
 * - OPENMEMORY_HSG_API_KEY
 * - OPENMEMORY_HSG_TIMEOUT_MS (optional, ms)
 */
import { logger } from '../../logging/logger';
import { getConfig } from '../../../config';
import { safeParseInt } from '../../../core/config/safe-parse';
import type {
  HSGClient,
  HSGAddToSectorInput,
  HSGQueryInput,
  HSGQueryResultItem,
} from '../../../domain/memory/session-memory-ports';
import type { HSGPointer } from '../../../domain/memory/session-types';
import { getOrCreateCounter, getOrCreateHistogram } from '../../../monitoring';
import { IdGenerator } from '../../../core/utils/IdGenerator';
import type {
  IHttpClient,
  HttpClientRequestOptions,
  HttpClientResponse,
} from '../../http/HttpClient';
import { NodeHttpJsonClient } from '../../http/HttpClient';
import { tryJsonParse } from '../../../core/utils/json';

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

const hsgRequestCounter = getOrCreateCounter(
  'openmemory_hsg_requests_total',
  'Total requests performed by OpenMemory HSG client',
  ['operation', 'outcome'],
);

const hsgRequestDuration = getOrCreateHistogram(
  'openmemory_hsg_request_duration_seconds',
  'Duration of OpenMemory HSG client requests in seconds',
  ['operation'],
);

export interface OpenMemoryHSGClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  environment?: OpenMemoryEnvironment;
}

interface OpenMemoryAddResponse {
  id?: string;
  sectors?: string[];
  graph_tags?: string[];
}

interface OpenMemoryGetMemoryResponse {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  sectors?: string[];
}

interface OpenMemoryQueryItem {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

interface OpenMemoryQueryResponse {
  items: OpenMemoryQueryItem[];
}

export class OpenMemoryHSGClient implements HSGClient {
  private readonly log = logger.child({ component: 'OpenMemoryHSGClient' });

  constructor(
    private readonly httpClient: IHttpClient,
    private readonly options: OpenMemoryHSGClientOptions,
  ) {}

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
    if (!this.shouldUseNetwork()) {
      return true;
    }

    try {
      const ok = await this.performHealthRequest();
      if (!ok) {
        this.log.warn('OpenMemory HSG health check reported unhealthy');
      }
      return ok;
    } catch (error) {
      const err = error as Error;
      this.log.error('OpenMemory HSG health check failed', { error: err.message });
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
    } catch (error) {
      const err = error as Error;
      this.log.error('Invalid baseUrl for OpenMemory HSG health check', {
        error: err.message,
      });
      return false;
    }

    try {
      const headers: Record<string, string> = {};
      if (this.options.apiKey) {
        headers.Authorization = `Bearer ${this.options.apiKey}`;
      }

      const response = await this.httpClient.request({
        method: 'GET',
        url: healthUrl,
        timeoutMs,
        headers,
      });

      const ok = response.statusCode >= 200 && response.statusCode < 300;
      return ok;
    } catch (error) {
      const err = error as Error;
      this.log.warn('OpenMemory HSG health check error', {
        error: err.message,
      });
      return false;
    }
  }

  private buildUrl(path: string): string {
    try {
      const base = new URL(this.baseUrl);
      const full = new URL(path, base);
      return full.toString();
    } catch (error) {
      const err = error as Error;
      this.log.error('Invalid baseUrl for OpenMemory HSG request', {
        path,
        error: err.message,
      });
      throw err;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    if (this.options.apiKey) {
      headers.Authorization = `Bearer ${this.options.apiKey}`;
    }

    return headers;
  }

  private async performJsonRequest(
    requestOptions: HttpClientRequestOptions,
    path: string,
  ): Promise<HttpClientResponse> {
    const response = await this.httpClient.request(requestOptions);

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response;
    }

    const limitedBody = response.body.slice(0, 512);

    if (response.statusCode === 401) {
      const message = `OpenMemoryHSGClient: unauthorized (HTTP 401) for ${path}`;
      this.log.warn(message, { statusCode: response.statusCode, body: limitedBody });
      throw new Error(message);
    }

    if (response.statusCode === 404) {
      const message = `OpenMemoryHSGClient: resource not found (HTTP 404) for ${path}`;
      this.log.warn(message, { statusCode: response.statusCode, body: limitedBody });
      throw new Error(message);
    }

    const message = `OpenMemoryHSGClient: HTTP ${response.statusCode} response for ${path}`;
    this.log.warn(message, { statusCode: response.statusCode, body: limitedBody });
    throw new Error(message);
  }

  private parseJsonBody<T>(body: string, path: string): T {
    if (!body) {
      return {} as T;
    }

    const parsed = tryJsonParse<T>(body);
    if (!parsed.ok) {
      const error = parsed.error;
      this.log.warn('Failed to parse OpenMemory HSG JSON response', {
        path,
        error: error.message,
      });
      throw error;
    }

    return parsed.value;
  }

  /**
   * addToSector:
   * - production: performs POST /memory/add against OpenMemory HSG;
   * - non-production: logs the request and returns a synthetic HSGPointer
   *   without performing any HTTP calls (backwards-compatible stub).
   */
  async addToSector(input: HSGAddToSectorInput): Promise<HSGPointer> {
    const operation = 'add_to_sector';
    const endTimer = hsgRequestDuration.startTimer({ operation });

    try {
      if (!this.shouldUseNetwork()) {
        this.log.debug('addToSector (stub)', {
          tenant_id: input.tenant_id,
          primary_sector: input.primary_sector,
          sectors: input.sectors,
          correlation_id: input.correlation_id,
        });

        const pointer: HSGPointer = {
          primary_sector: input.primary_sector,
          sectors: input.sectors ?? [input.primary_sector],
          hsg_id: IdGenerator.generateWithPrefix('stub'),
          graph_tags: [],
        };

        hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return pointer;
      }

      this.log.debug('addToSector (http)', {
        tenant_id: input.tenant_id,
        primary_sector: input.primary_sector,
        sectors: input.sectors,
        correlation_id: input.correlation_id,
      });

      const timeoutMs = this.options.timeoutMs ?? 5000;
      const url = this.buildUrl('/memory/add');
      const headers = this.buildHeaders();

      const body = {
        content: input.content,
        sector: input.primary_sector,
        sectors: input.sectors ?? [input.primary_sector],
        metadata: {
          ...(input.metadata ?? {}),
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          session_id: input.session_id,
          correlation_id: input.correlation_id,
        },
      };

      const response = await this.performJsonRequest(
        {
          method: 'POST',
          url,
          timeoutMs,
          headers,
          body,
        },
        '/memory/add',
      );

      const parsed = this.parseJsonBody<OpenMemoryAddResponse>(
        response.body,
        '/memory/add',
      );

      const pointer: HSGPointer = {
        primary_sector: input.primary_sector,
        sectors: parsed.sectors ?? (input.sectors ?? [input.primary_sector]),
        hsg_id: parsed.id ?? IdGenerator.generateWithPrefix('hsg'),
        graph_tags: parsed.graph_tags ?? [],
      };

      hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
      return pointer;
    } catch (error) {
      hsgRequestCounter.labels({ operation, outcome: 'error' }).inc();
      throw error;
    } finally {
      endTimer();
    }
  }

  /**
   * getMemory:
   * - production: performs GET /memory/{id} against OpenMemory HSG;
   * - non-production: logs request and returns null (backwards-compatible stub).
   */
  async getMemory(input: {
    tenant_id: string;
    hsg_id: string;
    correlation_id?: string;
  }): Promise<{ pointer: HSGPointer; content: string; metadata: Record<string, unknown> } | null> {
    const operation = 'get_memory';
    const endTimer = hsgRequestDuration.startTimer({ operation });

    try {
      if (!this.shouldUseNetwork()) {
        this.log.debug('getMemory (stub)', {
          tenant_id: input.tenant_id,
          hsg_id: input.hsg_id,
          correlation_id: input.correlation_id,
        });

        hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return null;
      }

      this.log.debug('getMemory (http)', {
        tenant_id: input.tenant_id,
        hsg_id: input.hsg_id,
        correlation_id: input.correlation_id,
      });

      const timeoutMs = this.options.timeoutMs ?? 5000;
      const url = this.buildUrl(`/memory/${encodeURIComponent(input.hsg_id)}`);
      const headers = this.buildHeaders();

      const response = await this.httpClient.request({
        method: 'GET',
        url,
        timeoutMs,
        headers,
      });

      if (response.statusCode === 404) {
        this.log.debug('OpenMemory HSG memory not found', {
          hsg_id: input.hsg_id,
        });
        hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return null;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const limitedBody = response.body.slice(0, 512);

        if (response.statusCode === 401) {
          const unauthorizedMessage = `OpenMemoryHSGClient: unauthorized (HTTP 401) for /memory/${encodeURIComponent(
            input.hsg_id,
          )}`;
          this.log.warn(unauthorizedMessage, {
            statusCode: response.statusCode,
            body: limitedBody,
          });
          throw new Error(unauthorizedMessage);
        }

        const message = `OpenMemoryHSGClient: HTTP ${response.statusCode} response for /memory/${encodeURIComponent(
          input.hsg_id,
        )}`;
        this.log.warn(message, { statusCode: response.statusCode, body: limitedBody });
        throw new Error(message);
      }

      const parsed = this.parseJsonBody<OpenMemoryGetMemoryResponse>(
        response.body,
        `/memory/${encodeURIComponent(input.hsg_id)}`,
      );

      const pointer: HSGPointer = {
        primary_sector: 'semantic',
        sectors: parsed.sectors ?? ['semantic'],
        hsg_id: parsed.id,
        graph_tags: [],
      };

      const metadata: Record<string, unknown> = parsed.metadata ?? {};

      hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
      return {
        pointer,
        content: parsed.content,
        metadata,
      };
    } catch (error) {
      hsgRequestCounter.labels({ operation, outcome: 'error' }).inc();
      throw error;
    } finally {
      endTimer();
    }
  }

  /**
   * query:
   * - production: performs POST /memory/query against OpenMemory HSG;
   * - non-production: logs request and returns an empty result set (backwards-compatible stub).
   */
  async query(input: HSGQueryInput): Promise<HSGQueryResultItem[]> {
    const operation = 'query';
    const endTimer = hsgRequestDuration.startTimer({ operation });

    try {
      if (!this.shouldUseNetwork()) {
        this.log.debug('query (stub)', {
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          session_id: input.session_id,
          sector: input.sector,
          limit: input.limit,
          correlation_id: input.correlation_id,
        });

        hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return [];
      }

      this.log.debug('query (http)', {
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        session_id: input.session_id,
        sector: input.sector,
        limit: input.limit,
        correlation_id: input.correlation_id,
      });

      const timeoutMs = this.options.timeoutMs ?? 5000;
      const url = this.buildUrl('/memory/query');
      const headers = this.buildHeaders();

      const sectorsArray =
        input.sector == null
          ? undefined
          : Array.isArray(input.sector)
          ? input.sector
          : [input.sector];

      const filters: Record<string, unknown> = {
        ...(input.filters ?? {}),
        tenant_id: input.tenant_id,
      };

      if (input.user_id) {
        filters.user_id = input.user_id;
      }

      if (input.session_id) {
        filters.session_id = input.session_id;
      }

      const body = {
        query: input.query,
        top_k: input.limit ?? 10,
        sectors: sectorsArray,
        filters,
      };

      const response = await this.performJsonRequest(
        {
          method: 'POST',
          url,
          timeoutMs,
          headers,
          body,
        },
        '/memory/query',
      );

      const parsed = this.parseJsonBody<OpenMemoryQueryResponse>(
        response.body,
        '/memory/query',
      );

      const items: HSGQueryResultItem[] = (parsed.items ?? []).map((item) => ({
        pointer: {
          primary_sector: 'semantic',
          sectors: ['semantic'],
          hsg_id: item.id,
          graph_tags: [],
        },
        score: item.score,
        content: item.content,
        metadata: item.metadata ?? {},
      }));

      hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
      return items;
    } catch (error) {
      hsgRequestCounter.labels({ operation, outcome: 'error' }).inc();
      throw error;
    } finally {
      endTimer();
    }
  }

  /**
   * createRelationship:
   * - production: performs POST /memory/graph/link against OpenMemory HSG;
   * - non-production: logs the relationship creation attempt and is a no-op (backwards-compatible stub).
   */
  async createRelationship(input: {
    tenant_id: string;
    source_id: string;
    target_id: string;
    relationship: string;
    weight?: number;
    metadata?: Record<string, unknown>;
    correlation_id?: string;
  }): Promise<void> {
    const operation = 'create_relationship';
    const endTimer = hsgRequestDuration.startTimer({ operation });

    try {
      if (!this.shouldUseNetwork()) {
        this.log.debug('createRelationship (stub)', {
          tenant_id: input.tenant_id,
          source_id: input.source_id,
          target_id: input.target_id,
          relationship: input.relationship,
          weight: input.weight,
          correlation_id: input.correlation_id,
        });

        hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return;
      }

      this.log.debug('createRelationship (http)', {
        tenant_id: input.tenant_id,
        source_id: input.source_id,
        target_id: input.target_id,
        relationship: input.relationship,
        weight: input.weight,
        correlation_id: input.correlation_id,
      });

      const timeoutMs = this.options.timeoutMs ?? 5000;
      const url = this.buildUrl('/memory/graph/link');
      const headers = this.buildHeaders();

      const body = {
        source_id: input.source_id,
        target_id: input.target_id,
        relationship: input.relationship,
        weight: input.weight,
        metadata: {
          ...(input.metadata ?? {}),
          tenant_id: input.tenant_id,
          correlation_id: input.correlation_id,
        },
      };

      await this.performJsonRequest(
        {
          method: 'POST',
          url,
          timeoutMs,
          headers,
          body,
        },
        '/memory/graph/link',
      );

      hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
    } catch (error) {
      hsgRequestCounter.labels({ operation, outcome: 'error' }).inc();
      throw error;
    } finally {
      endTimer();
    }
  }

  /**
   * getRelationships:
   * - production: performs GET /memory/graph/relationships against OpenMemory HSG;
   * - non-production: returns empty array (stub).
   */
  async getRelationships(input: {
    tenant_id: string;
    source_id: string;
    relationship?: string;
    direction?: 'incoming' | 'outgoing';
  }): Promise<Array<{ target_id: string; relationship: string; weight: number }>> {
    const operation = 'get_relationships';
    const endTimer = hsgRequestDuration.startTimer({ operation });

    try {
      if (!this.shouldUseNetwork()) {
        hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return [];
      }

      const params = new URLSearchParams({ source_id: input.source_id });
      if (input.relationship) params.set('type', input.relationship);
      if (input.direction) params.set('direction', input.direction);

      const url = `${this.buildUrl('/memory/graph/relationships')}?${params.toString()}`;
      const headers = this.buildHeaders();
      const timeoutMs = this.options.timeoutMs ?? 5000;

      const response = await this.httpClient.request({
        method: 'GET',
        url,
        timeoutMs,
        headers,
      });

      if (response.statusCode === 404) {
        hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return [];
      }

      if (response.statusCode >= 500) {
        throw new Error(`HTTP ${response.statusCode}`);
      }

      const bodyStr = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
      if (!bodyStr) {
        hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return [];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyStr);
      } catch {
        hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return [];
      }

      const items = Array.isArray(parsed)
        ? parsed
        : (parsed as Record<string, unknown>)?.relationships;

      if (!Array.isArray(items)) {
        hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
        return [];
      }

      hsgRequestCounter.labels({ operation, outcome: 'success' }).inc();
      return items.map((item: Record<string, unknown>) => ({
        target_id: String(item.target_id ?? ''),
        relationship: String(item.relationship ?? ''),
        weight: typeof item.weight === 'number' ? item.weight : 1.0,
      }));
    } catch (error) {
      hsgRequestCounter.labels({ operation, outcome: 'error' }).inc();
      throw error;
    } finally {
      endTimer();
    }
  }
}

/**
 * Factory for DI: creates an OpenMemoryHSGClient using environment variables.
 *
 * Defaults:
 * - baseUrl: OPENMEMORY_HSG_URL or dev fallback http://openmemory-hsg.dev.internal:8080
 *
 * Behaviour:
 * - production: requires valid OPENMEMORY_HSG_URL, fails fast with clear error if missing/invalid;
 * - development: allows fallback dev URL with warnings;
 * - test: allows fallback dev URL without warnings because network is disabled.
 */
export function createOpenMemoryHSGClientFromEnv(): HSGClient {
  const environment = resolveEnvironmentFromNodeEnv();
  const config = getConfig();
  const rawUrl = config.OPENMEMORY_HSG_URL;
  const fallbackDevUrl = 'http://openmemory-hsg.dev.internal:8080';

  let baseUrl: string;

  if (environment === 'production') {
    if (!rawUrl || rawUrl.length === 0) {
      const message =
        'OpenMemoryHSGClient: OPENMEMORY_HSG_URL is not configured for production';
      logger.error(message, { environment });
      throw new Error(message);
    }

    try {
      const parsed = new URL(rawUrl);
      baseUrl = parsed.toString();
    } catch (error) {
      const err = error as Error;
      const message =
        'OpenMemoryHSGClient: OPENMEMORY_HSG_URL is invalid URL for production';
      logger.error(message, { environment, reason: err.message });
      throw new Error(message);
    }
  } else {
    if (!rawUrl || rawUrl.length === 0) {
      baseUrl = fallbackDevUrl;
      if (environment === 'development') {
        logger.warn(
          'OPENMEMORY_HSG_URL is not set; using dev fallback for OpenMemory HSG client',
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
      } catch (error) {
        const err = error as Error;
        baseUrl = fallbackDevUrl;
        if (environment === 'development') {
          logger.warn(
            'OPENMEMORY_HSG_URL is invalid; using dev fallback for OpenMemory HSG client',
            {
              environment,
              reason: err.message,
              baseUrl,
            },
          );
        }
      }
    }
  }

  const apiKey = config.OPENMEMORY_HSG_API_KEY;
  const timeoutFromEnv = config.OPENMEMORY_HSG_TIMEOUT_MS;
  const timeoutMs = safeParseInt(timeoutFromEnv, 5000);
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;

  if (environment === 'production' && (!apiKey || apiKey.length === 0)) {
    logger.warn('OpenMemoryHSGClient: OPENMEMORY_HSG_API_KEY is not set for production', {
      environment,
    });
  }

  return new OpenMemoryHSGClient(
    new NodeHttpJsonClient(),
    {
      baseUrl,
      apiKey,
      timeoutMs: effectiveTimeoutMs,
      environment,
    },
  );
}