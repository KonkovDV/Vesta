import { IArticleFinder, Article, ResearchTopic } from '../../domain/research';
import type {
  IRequestContext,
  CorrelationId,
  RequestId,
  UserId,
  TenantId,
  SessionId,
  MasSessionId,
  MasTraceId,
  RequestContextData,
} from '../../core/context/request-context';
import type { DomainEvent } from '../../domain/events/event-store.interface';

interface ArticlePluginCaller {
  call<TInput, TData>(
    route: string,
    payload: TInput,
    requestContext: IRequestContext,
  ): Promise<{ data?: TData | null }>;
}

interface ScientificSkillsArticleDto {
  id?: string;
  title?: string;
  abstract?: string;
  summary?: string;
  source?: string;
}

type ScientificSkillsSearchResult = ScientificSkillsArticleDto[];

interface ScientificSkillsSearchPayload {
  skill: 'openalex-database' | 'pubmed-database';
  script: string;
  args: string[];
}

/**
 * Detached, minimal IRequestContext implementation for research plugin calls.
 *
 * Layer: Infrastructure
 *
 * Responsibilities:
 * - provide a stable correlationId/requestId for plugin telemetry;
 * - avoid dependency on AsyncLocal-based RequestContext runtime.
 *
 * This context:
 * - starts a new technical correlation chain per finder invocation;
 * - does not participate in HTTP RequestContext propagation;
 * - keeps metadata/pendingEvents as local, in-memory only.
 */
class ResearchPluginRequestContextStub implements IRequestContext {
  private correlationId: CorrelationId;
  private requestId: RequestId;
  private startedAt: Date;

  private userId?: UserId;
  private tenantId?: TenantId;
  private sessionId?: SessionId;
  private masSessionId?: MasSessionId;
  private masTraceId?: MasTraceId;
  private metadata?: Record<string, unknown>;
  private pendingEvents: DomainEvent[] = [];

  constructor() {
    const timestamp = Date.now();
    const base = `research_article_finder_${timestamp}`;

    this.correlationId = base as CorrelationId;
    this.requestId = (`req_${base}`) as RequestId;
    this.startedAt = new Date();
  }

  getCorrelationId(): CorrelationId {
    return this.correlationId;
  }

  setCorrelationId(id: CorrelationId): void {
    this.correlationId = id;
  }

  getUserId(): UserId | undefined {
    return this.userId;
  }

  setUserId(userId: UserId): void {
    this.userId = userId;
  }

  getSessionId(): SessionId | undefined {
    return this.sessionId;
  }

  setSessionId(sessionId: SessionId): void {
    this.sessionId = sessionId;
  }

  getTenantId(): TenantId | undefined {
    return this.tenantId;
  }

  setTenantId(tenantId: TenantId): void {
    this.tenantId = tenantId;
  }

  getRequestId(): RequestId {
    return this.requestId;
  }

  getMasSessionId(): MasSessionId | undefined {
    return this.masSessionId;
  }

  setMasSessionId(id: MasSessionId): void {
    this.masSessionId = id;
  }

  getMasTraceId(): MasTraceId | undefined {
    return this.masTraceId;
  }

  setMasTraceId(id: MasTraceId): void {
    this.masTraceId = id;
  }

  getContext(): RequestContextData {
    return {
      correlationId: this.correlationId,
      userId: this.userId,
      sessionId: this.sessionId,
      tenantId: this.tenantId,
      requestId: this.requestId,
      masSessionId: this.masSessionId,
      masTraceId: this.masTraceId,
      clientIp: undefined,
      userAgent: undefined,
      method: undefined,
      path: undefined,
      startedAt: this.startedAt,
      metadata: this.metadata,
    };
  }

  clear(): void {
    this.userId = undefined;
    this.sessionId = undefined;
    this.tenantId = undefined;
    this.masSessionId = undefined;
    this.masTraceId = undefined;
    this.metadata = undefined;
    this.pendingEvents = [];
  }

  isInitialized(): boolean {
    return true;
  }

  getAge(): number {
    return Date.now() - this.startedAt.getTime();
  }

  addMetadata(key: string, value: unknown): void {
    if (!this.metadata) {
      this.metadata = {};
    }
    this.metadata[key] = value;
  }

  getMetadata(key: string): unknown {
    return this.metadata?.[key];
  }

  addPendingEvent(event: DomainEvent): void {
    this.pendingEvents.push(event);
  }

  getPendingEvents(): DomainEvent[] {
    return [...this.pendingEvents];
  }

  clearPendingEvents(): void {
    this.pendingEvents = [];
  }

  createChild(_childCorrelationId?: CorrelationId): IRequestContext {
    // Child context starts a new technical chain while inheriting identity.
    const child = new ResearchPluginRequestContextStub();
    child.userId = this.userId;
    child.tenantId = this.tenantId;
    child.sessionId = this.sessionId;
    child.masSessionId = this.masSessionId;
    child.masTraceId = this.masTraceId;
    child.metadata = this.metadata ? { ...this.metadata } : undefined;
    return child;
  }

  clone(): IRequestContext {
    const clone = new ResearchPluginRequestContextStub();
    clone.correlationId = this.correlationId;
    clone.requestId = this.requestId;
    clone.startedAt = new Date(this.startedAt.getTime());
    clone.userId = this.userId;
    clone.tenantId = this.tenantId;
    clone.sessionId = this.sessionId;
    clone.masSessionId = this.masSessionId;
    clone.masTraceId = this.masTraceId;
    clone.metadata = this.metadata ? { ...this.metadata } : undefined;
    clone.pendingEvents = [...this.pendingEvents];
    return clone;
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    return await Promise.resolve(fn());
  }
}

export class PluginBasedArticleFinder implements IArticleFinder {
  constructor(private readonly pluginRegistry: ArticlePluginCaller) {}

  private createRequestContext(): IRequestContext {
    return new ResearchPluginRequestContextStub();
  }

  async findByTopic(topic: ResearchTopic, limit: number): Promise<Article[]> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 10;
    const halfLimit = Math.ceil(safeLimit / 2);
    const requestContext = this.createRequestContext();

    const openAlexResult = await this.pluginRegistry.call<
      ScientificSkillsSearchPayload,
      ScientificSkillsSearchResult
    >(
      'scientific-skills@1.0.0',
      {
        skill: 'openalex-database',
        script: 'search_works.py',
        args: ['--query', topic.value, '--limit', String(halfLimit)],
      },
      requestContext,
    );

    const pubMedResult = await this.pluginRegistry.call<
      ScientificSkillsSearchPayload,
      ScientificSkillsSearchResult
    >(
      'scientific-skills@1.0.0',
      {
        skill: 'pubmed-database',
        script: 'search.py',
        args: ['--query', topic.value, '--limit', String(halfLimit)],
      },
      requestContext,
    );

    const openAlexArticles: ScientificSkillsSearchResult = Array.isArray(
      openAlexResult.data,
    )
      ? openAlexResult.data
      : [];
    const pubMedArticles: ScientificSkillsSearchResult = Array.isArray(
      pubMedResult.data,
    )
      ? pubMedResult.data
      : [];

    const combined: ScientificSkillsArticleDto[] = [
      ...openAlexArticles,
      ...pubMedArticles,
    ];

    if (combined.length === 0) {
      return [];
    }

    return combined.slice(0, safeLimit).map((raw, index) => {
      const id =
        typeof raw.id === 'string' && raw.id.trim().length > 0
          ? raw.id
          : `article_${index}`;
      const title =
        typeof raw.title === 'string' && raw.title.trim().length > 0
          ? raw.title
          : 'Unknown Title';
      const abstractValue =
        (typeof raw.abstract === 'string' && raw.abstract) ||
        (typeof raw.summary === 'string' && raw.summary) ||
        '';
      const sourceValue =
        typeof raw.source === 'string' && raw.source.trim().length > 0
          ? raw.source
          : 'unknown';

      return Article.create({
        id,
        title,
        abstract: abstractValue,
        source: sourceValue,
      });
    });
  }
}