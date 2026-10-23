import { AggregateRoot, type DomainEvent as AggregateDomainEvent } from '../../core/domain/AggregateRoot';
import { ValueObject } from '../../core/domain/ValueObject';
import { DomainInvariantViolationError } from '../errors/DomainError';
import { ResearchReportId, ResearcherId } from './ResearchIdentifiers';
import {
  ResearchDomainEvent,
  createResearchReportCreatedEvent,
  createArticleAddedEvent,
  createArticleSummarizedEvent,
  createTrendsAnalyzedEvent,
  createResearchReportFinalizedEvent,
  isResearchReportCreatedEvent,
  isArticleAddedEvent,
  isArticleSummarizedEvent,
  isTrendsAnalyzedEvent,
  isResearchReportFinalizedEvent,
} from './events';

export { ResearchReportId, ResearcherId } from './ResearchIdentifiers';

export type ResearchReportStatus = 'draft' | 'in_progress' | 'completed' | 'failed';


interface ResearchTopicProps {
  value: string;
}

export class ResearchTopic extends ValueObject<ResearchTopicProps> {
  private static readonly MIN_LENGTH = 3;
  private static readonly MAX_LENGTH = 200;
  private static readonly KEYWORD_MIN_LENGTH = 3;

  private readonly keywordsInternal: string[];

  private constructor(props: ResearchTopicProps, keywords: string[]) {
    super(props);
    this.keywordsInternal = keywords;
  }

  static fromString(raw: string): ResearchTopic {
    const normalized = raw.trim();
    if (normalized.length < ResearchTopic.MIN_LENGTH) {
      throw new DomainInvariantViolationError(
        'RESEARCH_TOPIC_TOO_SHORT',
        `Research topic must be at least ${ResearchTopic.MIN_LENGTH} characters long`,
        { metadata: { valueLength: normalized.length } },
      );
    }
    if (normalized.length > ResearchTopic.MAX_LENGTH) {
      throw new DomainInvariantViolationError(
        'RESEARCH_TOPIC_TOO_LONG',
        `Research topic must be at most ${ResearchTopic.MAX_LENGTH} characters long`,
        { metadata: { valueLength: normalized.length } },
      );
    }
    const baseKeywords = normalized
      .toLowerCase()
      .split(/\s+/)
      .filter((part) => part.length >= ResearchTopic.KEYWORD_MIN_LENGTH);
    const keywords = baseKeywords.length > 0 ? baseKeywords : [normalized.toLowerCase()];
    return new ResearchTopic({ value: normalized }, keywords);
  }

  get value(): string {
    return this.props.value;
  }

  get keywords(): readonly string[] {
    return this.keywordsInternal;
  }
}

interface ResearchDepthProps {
  value: number;
}

export class ResearchDepth extends ValueObject<ResearchDepthProps> {
  private static readonly MIN_DEPTH = 1;
  private static readonly MAX_DEPTH = 100;

  private constructor(props: ResearchDepthProps) {
    super(props);
  }

  static create(raw: number): ResearchDepth {
    if (Number.isNaN(raw) || !Number.isFinite(raw)) {
      throw new DomainInvariantViolationError(
        'RESEARCH_DEPTH_INVALID_NUMBER',
        'Research depth must be a finite number',
        { metadata: { value: raw } },
      );
    }
    const value = Math.trunc(raw);
    if (value < ResearchDepth.MIN_DEPTH || value > ResearchDepth.MAX_DEPTH) {
      throw new DomainInvariantViolationError(
        'RESEARCH_DEPTH_OUT_OF_RANGE',
        `Research depth must be between ${ResearchDepth.MIN_DEPTH} and ${ResearchDepth.MAX_DEPTH}`,
        { metadata: { value } },
      );
    }
    return new ResearchDepth({ value });
  }

  get value(): number {
    return this.props.value;
  }
}

export class Article {
  public readonly id: string;
  public readonly title: string;
  public readonly abstract: string;
  public readonly source: string;

  private constructor(params: { id: string; title: string; abstract: string; source: string }) {
    this.id = params.id;
    this.title = params.title;
    this.abstract = params.abstract;
    this.source = params.source;
  }

  static create(params: { id: string; title: string; abstract: string; source: string }): Article {
    const trimmedTitle = params.title.trim();
    if (trimmedTitle.length === 0) {
      throw new DomainInvariantViolationError(
        'RESEARCH_ARTICLE_INVALID_TITLE',
        'Article title must be a non-empty string',
        { metadata: { articleId: params.id } },
      );
    }
    return new Article({
      id: params.id,
      title: trimmedTitle,
      abstract: params.abstract,
      source: params.source,
    });
  }
}

export class ArticleSummary {
  public readonly articleId: string;
  public readonly content: string;

  private constructor(articleId: string, content: string) {
    this.articleId = articleId;
    this.content = content;
  }

  static create(articleId: string, content: string): ArticleSummary {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new DomainInvariantViolationError(
        'RESEARCH_SUMMARY_EMPTY',
        'Summary content must be a non-empty string',
        { metadata: { articleId } },
      );
    }
    return new ArticleSummary(articleId, trimmed);
  }
}

export class ResearchTrends {
  public readonly summary: string;
  public readonly confidence: number;

  private constructor(summary: string, confidence: number) {
    this.summary = summary;
    this.confidence = confidence;
  }

  static create(summary: string, confidence: number): ResearchTrends {
    if (confidence < 0 || confidence > 1) {
      throw new DomainInvariantViolationError(
        'RESEARCH_TRENDS_CONFIDENCE_RANGE',
        'Trends confidence must be between 0 and 1',
        { metadata: { confidence } },
      );
    }
    return new ResearchTrends(summary.trim(), confidence);
  }
}

export interface IArticleFinder {
  findByTopic(topic: ResearchTopic, limit: number): Promise<Article[]>;
}

export interface IArticleSummarizer {
  summarize(article: Article): Promise<ArticleSummary>;
}

export interface ITrendAnalyzer {
  analyze(summaries: ArticleSummary[]): Promise<ResearchTrends>;
}

export interface ResearchReportProps {
  topic: ResearchTopic;
  articles: Article[];
  summaries: ArticleSummary[];
  trends?: ResearchTrends;
  status: ResearchReportStatus;
  createdAt: Date;
  createdBy: ResearcherId;
  completedAt?: Date;
}

export class ResearchReport extends AggregateRoot<ResearchReportProps> {
  private static readonly MAX_ARTICLES = 100;
  private static readonly MIN_ARTICLES_FOR_TRENDS = 10;
  private static readonly MAX_SUMMARY_LENGTH = 1000;

  private constructor(id: ResearchReportId, props: ResearchReportProps, version: number) {
    super(id, props, version);
  }

  static create(topic: ResearchTopic, requestedBy: ResearcherId): ResearchReport {
    const id = ResearchReportId.create();
    const now = new Date();
    const initialProps: ResearchReportProps = {
      topic,
      articles: [],
      summaries: [],
      trends: undefined,
      status: 'draft',
      createdAt: now,
      createdBy: requestedBy,
      completedAt: undefined,
    };
    const report = new ResearchReport(id, initialProps, 1);
    const event = createResearchReportCreatedEvent(id, report.version, {
      topic: topic.value,
      requestedBy: requestedBy.toValue(),
      createdAt: now.toISOString(),
    });
    report.addEvent(event);
    report.applyEvent(event);
    return report;
  }

  static restoreFromHistory(id: ResearchReportId, events: AggregateDomainEvent[]): ResearchReport {
    if (events.length === 0) {
      throw new DomainInvariantViolationError(
        'RESEARCH_REPORT_REHYDRATE_EMPTY_HISTORY',
        'Cannot rehydrate research report from empty event stream',
        { metadata: { aggregateId: id.toString() } },
      );
    }
    const placeholderProps: ResearchReportProps = {
      topic: ResearchTopic.fromString('placeholder'),
      articles: [],
      summaries: [],
      trends: undefined,
      status: 'draft',
      createdAt: new Date(0),
      createdBy: ResearcherId.fromString('placeholder'),
      completedAt: undefined,
    };
    const firstEvent = events[0];
    const report = new ResearchReport(id, placeholderProps, firstEvent.aggregateVersion);
    for (const event of events) {
      report.applyEvent(event);
    }
    report.clearEvents();
    return report;
  }

  /**
   * Восстановление агрегата из snapshot‑состояния.
   *
   * Ожидается, что snapshot был сформирован через serialize(), поэтому структура
   * данных совместима с этим методом. При некорректных/частично отсутствующих
   * полях используются безопасные значения по умолчанию, чтобы не падать при
   * чтении старых snapshot'ов.
   */
  static restoreFromSnapshot(snapshot: Record<string, unknown>): ResearchReport {
    const idRaw = typeof snapshot.id === 'string' ? snapshot.id : '';
    const versionRaw = typeof snapshot.version === 'number' ? snapshot.version : 1;
    const topicRaw = typeof snapshot.topic === 'string' ? snapshot.topic : '';
    const statusRaw = typeof snapshot.status === 'string' ? snapshot.status : 'draft';
    const createdAtRaw =
      typeof snapshot.createdAt === 'string' ? snapshot.createdAt : new Date(0).toISOString();
    const createdByRaw = typeof snapshot.createdBy === 'string' ? snapshot.createdBy : '';
    const completedAtRaw =
      typeof snapshot.completedAt === 'string' ? snapshot.completedAt : undefined;

    const status: ResearchReportStatus =
      statusRaw === 'draft' ||
      statusRaw === 'in_progress' ||
      statusRaw === 'completed' ||
      statusRaw === 'failed'
        ? statusRaw
        : 'draft';

    const articles: Article[] = [];
    const articlesValue = snapshot.articles;
    if (Array.isArray(articlesValue)) {
      for (const item of articlesValue) {
        if (item && typeof item === 'object') {
          const candidate = item as {
            id?: unknown;
            title?: unknown;
            abstract?: unknown;
            source?: unknown;
          };
          if (
            typeof candidate.id === 'string' &&
            typeof candidate.title === 'string' &&
            typeof candidate.abstract === 'string' &&
            typeof candidate.source === 'string'
          ) {
            articles.push(
              Article.create({
                id: candidate.id,
                title: candidate.title,
                abstract: candidate.abstract,
                source: candidate.source,
              }),
            );
          }
        }
      }
    }

    const summaries: ArticleSummary[] = [];
    const summariesValue = snapshot.summaries;
    if (Array.isArray(summariesValue)) {
      for (const item of summariesValue) {
        if (item && typeof item === 'object') {
          const candidate = item as {
            articleId?: unknown;
            content?: unknown;
          };
          if (
            typeof candidate.articleId === 'string' &&
            typeof candidate.content === 'string'
          ) {
            summaries.push(ArticleSummary.create(candidate.articleId, candidate.content));
          }
        }
      }
    }

    let trends: ResearchTrends | undefined;
    const trendsValue = snapshot.trends;
    if (trendsValue && typeof trendsValue === 'object') {
      const candidate = trendsValue as {
        summary?: unknown;
        confidence?: unknown;
      };
      if (
        typeof candidate.summary === 'string' &&
        typeof candidate.confidence === 'number'
      ) {
        trends = ResearchTrends.create(candidate.summary, candidate.confidence);
      }
    }

    const props: ResearchReportProps = {
      topic: ResearchTopic.fromString(topicRaw),
      articles,
      summaries,
      trends,
      status,
      createdAt: new Date(createdAtRaw),
      createdBy: ResearcherId.fromString(createdByRaw),
      completedAt: completedAtRaw ? new Date(completedAtRaw) : undefined,
    };

    const reportId = ResearchReportId.fromString(idRaw);
    const initialVersion = versionRaw > 0 ? versionRaw : 1;

    return new ResearchReport(reportId, props, initialVersion);
  }

  addArticle(article: Article): void {
    this.ensureNotCompleted();
    this.ensureNotMaxArticles();
    const relevanceScore = this.calculateRelevance(article);
    this.ensureRelevant(relevanceScore, article);
    const event = createArticleAddedEvent(this.id, this.version, {
      articleId: article.id,
      title: article.title,
      abstract: article.abstract,
      source: article.source,
      relevanceScore,
    });
    this.addEvent(event);
    this.applyEvent(event);
  }

  addArticles(articles: Article[]): void {
    for (const article of articles) {
      this.addArticle(article);
    }
  }

  async generateSummaries(summarizer: IArticleSummarizer): Promise<void> {
    this.ensureHasArticles();
    this.ensureNotCompleted();
    const articlesSnapshot = this.props.articles;
    for (const article of articlesSnapshot) {
      const summary = await summarizer.summarize(article);
      this.ensureValidSummary(summary);
      const event = createArticleSummarizedEvent(this.id, this.version, {
        articleId: summary.articleId,
        summary: summary.content,
        summaryLength: summary.content.length,
      });
      this.addEvent(event);
      this.applyEvent(event);
    }
    if (this.props.status === 'draft') {
      this.setProps({ ...this.props, status: 'in_progress' });
    }
  }

  async analyzeTrends(analyzer: ITrendAnalyzer): Promise<void> {
    this.ensureMinArticlesForTrends();
    this.ensureHasSummaries();
    const trends = await analyzer.analyze(this.props.summaries);
    const event = createTrendsAnalyzedEvent(this.id, this.version, {
      summary: trends.summary,
      confidence: trends.confidence,
    });
    this.addEvent(event);
    this.applyEvent(event);
  }

  finalize(): void {
    this.ensureHasSummaries();
    this.ensureHasTrends();
    this.ensureNotCompleted();
    const now = new Date();
    const event = createResearchReportFinalizedEvent(this.id, this.version, {
      completedAt: now.toISOString(),
      articlesCount: this.props.articles.length,
      summariesCount: this.props.summaries.length,
    });
    this.addEvent(event);
    this.applyEvent(event);
  }

  private ensureNotMaxArticles(): void {
    if (this.props.articles.length >= ResearchReport.MAX_ARTICLES) {
      throw new DomainInvariantViolationError(
        'RESEARCH_REPORT_MAX_ARTICLES',
        `Maximum number of articles (${ResearchReport.MAX_ARTICLES}) reached for research report`,
        { metadata: { currentCount: this.props.articles.length, reportId: this.id.toString() } },
      );
    }
  }

  private ensureRelevant(score: number, article: Article): void {
    const minScore = 0.5;
    if (score < minScore) {
      throw new DomainInvariantViolationError(
        'RESEARCH_ARTICLE_RELEVANCE_TOO_LOW',
        'Article is not relevant enough to be included in research report',
        { metadata: { articleId: article.id, title: article.title, relevanceScore: score, minScore } },
      );
    }
  }

  private ensureHasArticles(): void {
    if (this.props.articles.length === 0) {
      throw new DomainInvariantViolationError(
        'RESEARCH_REPORT_NO_ARTICLES',
        'Cannot generate summaries for research report without articles',
        { metadata: { reportId: this.id.toString() } },
      );
    }
  }

  private ensureMinArticlesForTrends(): void {
    if (this.props.articles.length < ResearchReport.MIN_ARTICLES_FOR_TRENDS) {
      throw new DomainInvariantViolationError(
        'RESEARCH_REPORT_NOT_ENOUGH_ARTICLES_FOR_TRENDS',
        'Not enough articles for trends analysis',
        {
          metadata: {
            required: ResearchReport.MIN_ARTICLES_FOR_TRENDS,
            actual: this.props.articles.length,
            reportId: this.id.toString(),
          },
        },
      );
    }
  }

  private ensureHasSummaries(): void {
    if (this.props.summaries.length === 0) {
      throw new DomainInvariantViolationError(
        'RESEARCH_REPORT_NO_SUMMARIES',
        'Cannot analyze trends or finalize report without summaries',
        { metadata: { reportId: this.id.toString() } },
      );
    }
  }

  private ensureHasTrends(): void {
    if (!this.props.trends) {
      throw new DomainInvariantViolationError(
        'RESEARCH_REPORT_NO_TRENDS',
        'Cannot finalize report before trends are analyzed',
        { metadata: { reportId: this.id.toString() } },
      );
    }
  }

  private ensureNotCompleted(): void {
    if (this.props.status === 'completed') {
      throw new DomainInvariantViolationError(
        'RESEARCH_REPORT_ALREADY_COMPLETED',
        'Completed research report cannot be modified',
        { metadata: { reportId: this.id.toString() } },
      );
    }
  }

  private ensureValidSummary(summary: ArticleSummary): void {
    if (summary.content.length > ResearchReport.MAX_SUMMARY_LENGTH) {
      throw new DomainInvariantViolationError(
        'RESEARCH_SUMMARY_TOO_LONG',
        `Summary is too long: ${summary.content.length} characters`,
        {
          metadata: {
            articleId: summary.articleId,
            summaryLength: summary.content.length,
            maxLength: ResearchReport.MAX_SUMMARY_LENGTH,
          },
        },
      );
    }
  }

  private calculateRelevance(article: Article): number {
    const topicKeywords = this.props.topic.keywords;
    if (topicKeywords.length === 0) {
      return 0;
    }
    const text = `${article.title} ${article.abstract}`.toLowerCase();
    let matches = 0;
    for (const keyword of topicKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        matches += 1;
      }
    }
    return matches / topicKeywords.length;
  }

  protected when(event: AggregateDomainEvent): void {
    if (isResearchReportCreatedEvent(event)) {
      this.whenReportCreated(event);
      return;
    }
    if (isArticleAddedEvent(event)) {
      this.whenArticleAdded(event);
      return;
    }
    if (isArticleSummarizedEvent(event)) {
      this.whenArticleSummarized(event);
      return;
    }
    if (isTrendsAnalyzedEvent(event)) {
      this.whenTrendsAnalyzed(event);
      return;
    }
    if (isResearchReportFinalizedEvent(event)) {
      this.whenReportFinalized(event);
    }
  }

  private whenReportCreated(event: AggregateDomainEvent): void {
    const payload = event.payload;
    const topicRaw = typeof payload.topic === 'string' ? payload.topic : '';
    const requestedByRaw = typeof payload.requestedBy === 'string' ? payload.requestedBy : '';
    const createdAtRaw = typeof payload.createdAt === 'string' ? payload.createdAt : new Date(0).toISOString();
    const props: ResearchReportProps = {
      topic: ResearchTopic.fromString(topicRaw),
      articles: [],
      summaries: [],
      trends: undefined,
      status: 'draft',
      createdAt: new Date(createdAtRaw),
      createdBy: ResearcherId.fromString(requestedByRaw),
      completedAt: undefined,
    };
    this.setProps(props);
  }

  private whenArticleAdded(event: AggregateDomainEvent): void {
    const payload = event.payload;
    const articleId = typeof payload.articleId === 'string' ? payload.articleId : '';
    const title = typeof payload.title === 'string' ? payload.title : '';
    const abstractValue = typeof payload.abstract === 'string' ? payload.abstract : '';
    const source = typeof payload.source === 'string' ? payload.source : '';
    const article = Article.create({ id: articleId, title, abstract: abstractValue, source });
    this.setProps({ ...this.props, articles: [...this.props.articles, article] });
  }

  private whenArticleSummarized(event: AggregateDomainEvent): void {
    const payload = event.payload;
    const articleId = typeof payload.articleId === 'string' ? payload.articleId : '';
    const summaryContent = typeof payload.summary === 'string' ? payload.summary : '';
    const summary = ArticleSummary.create(articleId, summaryContent);
    this.setProps({
      ...this.props,
      summaries: [...this.props.summaries, summary],
      status: this.props.status === 'completed' ? 'completed' : 'in_progress',
    });
  }

  private whenTrendsAnalyzed(event: AggregateDomainEvent): void {
    const payload = event.payload;
    const summary = typeof payload.summary === 'string' ? payload.summary : '';
    const confidenceRaw = payload.confidence;
    const confidence = typeof confidenceRaw === 'number' ? confidenceRaw : 0;
    const trends = ResearchTrends.create(summary, confidence);
    this.setProps({ ...this.props, trends });
  }

  private whenReportFinalized(event: AggregateDomainEvent): void {
    const payload = event.payload;
    const completedAtRaw = typeof payload.completedAt === 'string' ? payload.completedAt : new Date().toISOString();
    this.setProps({ ...this.props, status: 'completed', completedAt: new Date(completedAtRaw) });
  }

  get topic(): ResearchTopic {
    return this.props.topic;
  }

  get articlesCount(): number {
    return this.props.articles.length;
  }

  get status(): ResearchReportStatus {
    return this.props.status;
  }

  get isCompleted(): boolean {
    return this.props.status === 'completed';
  }

  get completedAt(): Date | undefined {
    return this.props.completedAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get createdBy(): ResearcherId {
    return this.props.createdBy;
  }

  serialize(): Record<string, unknown> {
    return {
      id: this.id.toString(),
      version: this.version,
      topic: this.props.topic.value,
      status: this.props.status,
      createdAt: this.props.createdAt.toISOString(),
      createdBy: this.props.createdBy.toValue(),
      completedAt: this.props.completedAt ? this.props.completedAt.toISOString() : undefined,
      articles: this.props.articles.map((article) => ({
        id: article.id,
        title: article.title,
        abstract: article.abstract,
        source: article.source,
      })),
      summaries: this.props.summaries.map((summary) => ({
        articleId: summary.articleId,
        content: summary.content,
      })),
      trends: this.props.trends
        ? { summary: this.props.trends.summary, confidence: this.props.trends.confidence }
        : undefined,
    };
  }
}