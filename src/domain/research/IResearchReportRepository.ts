/**
 * IResearchReportRepository - интерфейс репозитория для агрегата ResearchReport
 * Layer: Domain (бизнес-логика)
 *
 * Определяет контракт для сохранения и загрузки агрегатов ResearchReport.
 * Следует принципу Dependency Inversion - Domain не зависит от Infrastructure.
 *
 * Принципы:
 * - Интерфейс определяется в Domain слое
 * - Реализация будет в Infrastructure слое
 * - Обеспечивает persistence ignorance (незнание о деталях хранения)
 * - Работает с доменными типами, а не с DTO
 */

import { ResearchReport } from './ResearchReport';
import { ResearchReportId } from './ResearchReport';
import { ResearcherId } from './ResearchReport';

/**
 * Результат операции репозитория
 */
export type RepositoryResult<T> = {
  success: true;
  data: T;
} | {
  success: false;
  error: RepositoryError;
};

/**
 * Типы ошибок репозитория
 */
export enum RepositoryErrorType {
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Ошибка репозитория
 */
export class RepositoryError extends Error {
  constructor(
    public readonly type: RepositoryErrorType,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RepositoryError';
  }

  static notFound(id: string, cause?: Error): RepositoryError {
    return new RepositoryError(
      RepositoryErrorType.NOT_FOUND,
      `Отчёт о исследованиях с ID ${id} не найден`,
      cause
    );
  }

  static conflict(id: string, cause?: Error): RepositoryError {
    return new RepositoryError(
      RepositoryErrorType.CONFLICT,
      `Конфликт версий для отчёта о исследованиях ${id}. Возможно, он был изменён другим процессом`,
      cause
    );
  }

  static connectionError(message: string, cause?: Error): RepositoryError {
    return new RepositoryError(
      RepositoryErrorType.CONNECTION_ERROR,
      `Ошибка подключения к хранилищу: ${message}`,
      cause
    );
  }

  static validationError(message: string, cause?: Error): RepositoryError {
    return new RepositoryError(
      RepositoryErrorType.VALIDATION_ERROR,
      `Ошибка валидации данных: ${message}`,
      cause
    );
  }

  static unknown(message: string, cause?: Error): RepositoryError {
    return new RepositoryError(
      RepositoryErrorType.UNKNOWN_ERROR,
      message,
      cause
    );
  }
}

/**
 * Опции для поиска отчётов о исследованиях
 */
export interface FindResearchReportsOptions {
  /** Фильтр по исследователю */
  researcherId?: string;
  /** Фильтр по статусу */
  status?: 'draft' | 'in_progress' | 'completed' | 'failed';
  /** Фильтр по ключевым словам в теме */
  topicKeywords?: string[];
  /** Лимит результатов */
  limit?: number;
  /** Смещение для пагинации */
  offset?: number;
  /** Сортировка */
  sortBy?: 'created_at' | 'updated_at';
  /** Порядок сортировки */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Результат поиска отчётов о исследованиях с пагинацией
 */
export interface ResearchReportSearchResult {
  /** Найденные отчёты */
  reports: ResearchReport[];
  /** Общее количество (для пагинации) */
  total: number;
  /** Количество возвращенных результатов */
  count: number;
  /** Смещение */
  offset: number;
  /** Лимит */
  limit: number;
}

/**
 * IResearchReportRepository - интерфейс для работы с агрегатами ResearchReport
 *
 * Определяет операции для persistence агрегатов без привязки к конкретной технологии хранения.
 *
 * Реализация этого интерфейса будет в Infrastructure слое и может использовать:
 * - SQL базы данных (PostgreSQL, MySQL)
 * - NoSQL базы данных (MongoDB, DynamoDB)
 * - Event Store для Event Sourcing
 * - In-memory хранилище для тестов
 *
 * @example
 * ```typescript
 * // Application Layer использует интерфейс
 * class ConductResearchUseCase {
 *   constructor(private repo: IResearchReportRepository) {}
 *
 *   async execute(command: ConductResearchCommand) {
 *     const result = await this.repo.findById(command.reportId);
 *     if (!result.success) {
 *       throw result.error;
 *     }
 *
 *     const report = result.data;
 *     report.addArticle(article);
 *     report.generateSummaries(this.summarizer);
 *     report.analyzeTrends(this.analyzer);
 *     report.finalize();
 *
 *     await this.repo.save(report);
 *   }
 * }
 * ```
 */
export interface IResearchReportRepository {
  /**
   * Найти отчёт о исследованиях по ID
   *
   * @param id - ID отчёта
   * @returns Result с агрегатом или ошибкой
   *
   * @example
   * ```typescript
   * const result = await repository.findById(reportId);
   * if (result.success) {
   *   const report = result.data;
   *   // Работаем с отчётом
   * } else {
   *   // Обрабатываем ошибку
   *   console.error(result.error);
   * }
   * ```
   */
  findById(id: ResearchReportId): Promise<RepositoryResult<ResearchReport>>;

  /**
   * Найти отчёт о исследованиях по ID или вернуть null
   * Удобная альтернатива findById для случаев, когда отсутствие - не ошибка
   *
   * @param id - ID отчёта
   * @returns Агрегат или null если не найден
   * @throws RepositoryError при других ошибках (не NOT_FOUND)
   *
   * @example
   * ```typescript
   * const report = await repository.findByIdOrNull(reportId);
   * if (report) {
   *   // Отчёт найден
   * } else {
   *   // Отчёт не найден - создаём новый
   * }
   * ```
   */
  findByIdOrNull(id: ResearchReportId): Promise<ResearchReport | null>;

  /**
   * Найти отчёты о исследованиях по критериям
   *
   * @param options - Опции поиска и фильтрации
   * @returns Result с результатами поиска
   *
   * @example
   * ```typescript
   * const result = await repository.find({
   *   researcherId: 'user_123',
   *   status: 'completed',
   *   limit: 20,
   *   sortBy: 'created_at',
   *   sortOrder: 'desc'
   * });
   * ```
   */
  find(options: FindResearchReportsOptions): Promise<RepositoryResult<ResearchReportSearchResult>>;

  /**
   * Сохранить агрегат
   *
   * Сохраняет изменения агрегата и его доменные события в рамках транзакции.
   * Реализация должна:
   * 1. Проверить версию агрегата (optimistic locking)
   * 2. Сохранить состояние агрегата
   * 3. Сохранить доменные события в Outbox
   * 4. Очистить список событий агрегата
   *
   * @param report - Агрегат для сохранения
   * @returns Result с сохраненным агрегатом или ошибкой
   * @throws RepositoryError.CONFLICT при конфликте версий
   *
   * @example
   * ```typescript
   * report.addArticle(article);
   * const result = await repository.save(report);
   * if (result.success) {
   *   console.log('Сохранено успешно');
   * }
   * ```
   */
  save(report: ResearchReport): Promise<RepositoryResult<ResearchReport>>;

  /**
   * Удалить отчёт о исследованиях (soft delete)
   *
   * Помечает отчёт как удаленный, но не удаляет физически.
   * Это сохраняет историю для аудита.
   *
   * @param id - ID отчёта
   * @returns Result с успехом или ошибкой
   *
   * @example
   * ```typescript
   * const result = await repository.delete(reportId);
   * ```
   */
  delete(id: ResearchReportId): Promise<RepositoryResult<void>>;

  /**
   * Проверить существование отчёта о исследованиях
   *
   * @param id - ID отчёта
   * @returns true если отчёт существует
   *
   * @example
   * ```typescript
   * if (await repository.exists(reportId)) {
   *   // Отчёт существует
   * }
   * ```
   */
  exists(id: ResearchReportId): Promise<boolean>;

  /**
   * Подсчитать количество отчётов о исследованиях по критериям
   *
   * @param options - Опции фильтрации (без пагинации)
   * @returns Количество отчётов
   *
   * @example
   * ```typescript
   * const completedCount = await repository.count({ status: 'completed' });
   * ```
   */
  count(options?: Omit<FindResearchReportsOptions, 'limit' | 'offset' | 'sortBy' | 'sortOrder'>): Promise<number>;

  /**
   * Восстановить агрегат из Event Store (для Event Sourcing)
   *
   * Опциональный метод для реализаций, использующих Event Sourcing.
   * Восстанавливает состояние агрегата путем последовательного применения событий.
   *
   * @param id - ID отчёта
   * @returns Result с восстановленным агрегатом
   *
   * @example
   * ```typescript
   * const result = await repository.rehydrate(reportId);
   * if (result.success) {
   *   const report = result.data;
   *   // Агрегат восстановлен из событий
   * }
   * ```
   */
  rehydrate?(id: ResearchReportId): Promise<RepositoryResult<ResearchReport>>;
}

/**
 * Базовая реализация In-Memory репозитория для тестов
 *
 * Используется в unit-тестах для изоляции Domain логики от Infrastructure.
 * НЕ ИСПОЛЬЗОВАТЬ в production!
 *
 * @example
 * ```typescript
 * const repository = new InMemoryResearchReportRepository();
 * const report = ResearchReport.create(topic, researcher);
 * await repository.save(report);
 * ```
 */
export class InMemoryResearchReportRepository implements IResearchReportRepository {
  private reports = new Map<string, ResearchReport>();

  async findById(id: ResearchReportId): Promise<RepositoryResult<ResearchReport>> {
    const report = this.reports.get(id.toValue());
    if (!report) {
      return {
        success: false,
        error: RepositoryError.notFound(id.toValue()),
      };
    }
    return { success: true, data: report };
  }

  async findByIdOrNull(id: ResearchReportId): Promise<ResearchReport | null> {
    return this.reports.get(id.toValue()) || null;
  }

  async find(options: FindResearchReportsOptions): Promise<RepositoryResult<ResearchReportSearchResult>> {
    let reports = Array.from(this.reports.values());

    // Применяем фильтры
    if (options.researcherId) {
      reports = reports.filter((r) => r.createdBy.toValue() === options.researcherId);
    }
    if (options.status) {
      reports = reports.filter(r => r.status === options.status);
    }
    const topicKeywords = options.topicKeywords;
    if (Array.isArray(topicKeywords) && topicKeywords.length > 0) {
      reports = reports.filter(r =>
        topicKeywords.some(keyword =>
          r.topic.value.toLowerCase().includes(keyword.toLowerCase())
        )
      );
    }

    // Сортировка
    const sortOrder = options.sortOrder || 'desc';
    reports.sort((a, b) => {
      const aTime = a.createdAt;
      const bTime = b.createdAt;
      return sortOrder === 'asc' ? aTime.getTime() - bTime.getTime() : bTime.getTime() - aTime.getTime();
    });

    const total = reports.length;
    const offset = options.offset || 0;
    const limit = options.limit || 10;

    // Пагинация
    reports = reports.slice(offset, offset + limit);

    return {
      success: true,
      data: {
        reports,
        total,
        count: reports.length,
        offset,
        limit,
      },
    };
  }

  async save(report: ResearchReport): Promise<RepositoryResult<ResearchReport>> {
    // Проверка версии для optimistic locking
    const existing = this.reports.get(report.id.toValue());
    if (existing && existing.version !== report.version - 1) {
      return {
        success: false,
        error: RepositoryError.conflict(report.id.toValue()),
      };
    }

    // Очищаем события (они должны быть обработаны перед сохранением)
    report.clearEvents();

    // Сохраняем
    this.reports.set(report.id.toValue(), report);

    return { success: true, data: report };
  }

  async delete(id: ResearchReportId): Promise<RepositoryResult<void>> {
    const report = this.reports.get(id.toValue());
    if (!report) {
      return {
        success: false,
        error: RepositoryError.notFound(id.toValue()),
      };
    }

    // Soft delete - помечаем как удаленный (в реальности нужно добавить поле status)
    this.reports.delete(id.toValue());

    return { success: true, data: undefined };
  }

  async exists(id: ResearchReportId): Promise<boolean> {
    return this.reports.has(id.toValue());
  }

  async count(options?: Omit<FindResearchReportsOptions, 'limit' | 'offset' | 'sortBy' | 'sortOrder'>): Promise<number> {
    let reports = Array.from(this.reports.values());

    if (options?.researcherId) {
      reports = reports.filter((r) => r.createdBy.toValue() === options.researcherId);
    }
    if (options?.status) {
      reports = reports.filter(r => r.status === options.status);
    }
    const topicKeywords = options?.topicKeywords;
    if (Array.isArray(topicKeywords) && topicKeywords.length > 0) {
      reports = reports.filter(r =>
        topicKeywords.some(keyword =>
          r.topic.value.toLowerCase().includes(keyword.toLowerCase())
        )
      );
    }

    return reports.length;
  }

  // Утилиты для тестов
  clear(): void {
    this.reports.clear();
  }

  getAll(): ResearchReport[] {
    return Array.from(this.reports.values());
  }
}