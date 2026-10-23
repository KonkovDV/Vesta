/**
 * IVectorStore — минимальный доменный контракт для векторного хранилища.
 *
 * Layer: Domain
 *
 * Цели:
 * - абстрагировать Memory / Retrieval от конкретной реализации (pgvector, Qdrant и др.);
 * - позволить подменять реализации через DI без изменения приложений;
 * - не тянуть в Domain детали БД, HTTP и конкретных клиентов.
 */

export interface VectorDocument {
  /** Стабильный идентификатор документа/факта. */
  id: string;
  /** Эмбеддинг фиксированной размерности. */
  embedding: number[];
  /** Произвольные метаданные (не должны содержать PII без governance-слоя). */
  metadata?: Record<string, unknown>;
  /** Логический namespace/collection внутри хранилища. */
  namespace?: string;
}

/**
 * Фильтры поиска по метаданным.
 *
 * Интерпретация ключей/значений определяется адаптером (pgvector, Qdrant и т.п.),
 * но интерфейс сохраняется стабильным для Memory/Retrieval слоёв.
 */
export type VectorSearchFilters = Record<string, unknown>;

export interface VectorSearchQuery {
  /** Эмбеддинг запроса. */
  queryEmbedding: number[];
  /** Количество лучших результатов. */
  topK: number;
  /** Ограничение поиска конкретным namespace/collection (опционально). */
  namespace?: string;
  /** Фильтры по метаданным (опционально). */
  filters?: VectorSearchFilters;
}

export interface VectorSearchResult {
  id: string;
  /** Нормализованный скор похожести: чем больше, тем релевантнее. */
  score: number;
  metadata?: Record<string, unknown>;
  namespace?: string;
}

/**
 * Доменный порт для операций с векторным хранилищем.
 *
 * Важно:
 * - не протекают детали SQL/HTTP/клиентов;
 * - реализуется исключительно в Infrastructure-слое;
 * - используется Memory / Retrieval / MAS только через DI.
 */
export interface IVectorStore {
  /**
   * Идемпотентный upsert набора документов.
   */
  upsertEmbeddings(documents: VectorDocument[]): Promise<void>;

  /**
   * Логическое удаление документов по идентификаторам в рамках namespace.
   *
   * Конкретная реализация может использовать физическое удаление или soft-delete.
   */
  deleteByIds(ids: string[], namespace?: string): Promise<void>;

  /**
   * Векторный поиск по эмбеддингу и метаданным.
   */
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
}