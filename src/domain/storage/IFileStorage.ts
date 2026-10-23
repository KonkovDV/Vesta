/**
 * IFileStorage - интерфейс для работы с файловым хранилищем
 * Layer: Domain (бизнес-логика)
 *
 * Определяет контракт для хранения и загрузки файлов.
 * Следует принципу Dependency Inversion - Domain не зависит от конкретного хранилища.
 *
 * @example
 * ```typescript
 * // Application Layer использует интерфейс
 * class FileUploadService {
 *   constructor(private storage: IFileStorage) {}
 *
 *   async uploadAvatar(userId: string, file: FileData): Promise<string> {
 *     const path = `avatars/${userId}/${uuid()}.jpg`;
 *     const url = await this.storage.upload(file, path);
 *     return url;
 *   }
 * }
 * ```
 */

import { Timestamp } from '../../core/types';

/**
 * Данные файла
 */
export interface FileData {
  /** Бинарные данные файла */
  buffer: Buffer;
  /** Имя файла */
  filename: string;
  /** MIME тип */
  mimeType: string;
  /** Размер в байтах */
  size: number;
  /** Метаданные файла */
  metadata?: Record<string, unknown>;
}

/**
 * Метаданные файла
 */
export interface FileMetadata {
  /** Размер файла в байтах */
  size: number;
  /** MIME тип */
  mimeType: string;
  /** Время создания */
  createdAt: Timestamp;
  /** Время последнего изменения */
  modifiedAt: Timestamp;
  /** ETag для кэширования */
  etag?: string;
  /** Контрольная сумма */
  checksum?: string;
  /** Пользовательские метаданные */
  customMetadata?: Record<string, unknown>;
}

/**
 * Опции загрузки файла
 */
export interface UploadOptions {
  /** MIME тип файла */
  mimeType?: string;
  /** Метаданные файла */
  metadata?: Record<string, unknown>;
  /** Права доступа */
  acl?: 'private' | 'public-read' | 'authenticated-read';
  /** Время жизни файла в секундах */
  expiresInSeconds?: number;
  /** Настройки шифрования */
  encryption?: {
    algorithm: string;
    key?: string;
  };
}

/**
 * Опции загрузки файла
 */
export interface DownloadOptions {
  /** Диапазон байтов для загрузки */
  range?: {
    start: number;
    end?: number;
  };
  /** Версия файла */
  versionId?: string;
  /** Настройки шифрования */
  encryption?: {
    algorithm: string;
    key?: string;
  };
}

/**
 * Результат загрузки файла
 */
export interface UploadResult {
  /** URL для доступа к файлу */
  url: string;
  /** ETag файла */
  etag: string;
  /** Версия файла */
  versionId?: string;
  /** Контрольная сумма */
  checksum?: string;
  /** Время загрузки */
  uploadedAt: Timestamp;
}

/**
 * Результат загрузки файла
 */
export interface DownloadResult extends FileData {
  /** ETag файла */
  etag: string;
  /** Время последнего изменения */
  lastModified: Timestamp;
  /** Версия файла */
  versionId?: string;
}

/**
 * Опции копирования файла
 */
export interface CopyOptions {
  /** Новое расположение файла */
  destination: string;
  /** Метаданные для копии */
  metadata?: Record<string, unknown>;
  /** Права доступа для копии */
  acl?: 'private' | 'public-read' | 'authenticated-read';
}

/**
 * Опции перемещения файла
 */
export interface MoveOptions {
  /** Новое расположение файла */
  destination: string;
  /** Метаданные для перемещенного файла */
  metadata?: Record<string, unknown>;
  /** Права доступа для перемещенного файла */
  acl?: 'private' | 'public-read' | 'authenticated-read';
}

/**
 * Опции поиска файлов
 */
export interface ListFilesOptions {
  /** Префикс для поиска */
  prefix?: string;
  /** Максимальное количество результатов */
  maxKeys?: number;
  /** Маркер продолжения */
  continuationToken?: string;
  /** Фильтр по расширению файла */
  extension?: string;
  /** Фильтр по MIME типу */
  mimeType?: string;
}

/**
 * Результат поиска файлов
 */
export interface ListFilesResult {
  /** Найденные файлы */
  files: FileInfo[];
  /** Маркер для продолжения поиска */
  continuationToken?: string;
  /** Общее количество файлов */
  totalCount?: number;
  /** Признак неполного результата */
  isTruncated: boolean;
}

/**
 * Информация о файле
 */
export interface FileInfo {
  /** Путь к файлу */
  path: string;
  /** Размер файла */
  size: number;
  /** Время последнего изменения */
  lastModified: Timestamp;
  /** ETag файла */
  etag: string;
  /** MIME тип */
  mimeType?: string;
  /** Версия файла */
  versionId?: string;
}

/**
 * IFileStorage - интерфейс для файлового хранилища
 *
 * Определяет операции для работы с файлами без привязки к конкретному хранилищу.
 * Реализация этого интерфейса будет в Infrastructure слое и может использовать:
 * - Amazon S3
 * - Google Cloud Storage
 * - Azure Blob Storage
 * - Локальная файловая система
 * - In-memory storage для тестов
 */
export interface IFileStorage {
  /**
   * Загрузить файл в хранилище
   *
   * @param fileData - Данные файла
   * @param path - Путь для сохранения файла
   * @param options - Опции загрузки
   * @returns Результат загрузки
   *
   * @example
   * ```typescript
   * const fileData = {
   *   buffer: fs.readFileSync('avatar.jpg'),
   *   filename: 'avatar.jpg',
   *   mimeType: 'image/jpeg',
   *   size: 1024000
   * };
   *
   * const result = await storage.upload(fileData, 'avatars/user123/avatar.jpg');
   * console.log('Файл загружен:', result.url);
   * ```
   */
  upload(fileData: FileData, path: string, options?: UploadOptions): Promise<UploadResult>;

  /**
   * Загрузить файл из хранилища
   *
   * @param path - Путь к файлу
   * @param options - Опции загрузки
   * @returns Данные файла
   *
   * @example
   * ```typescript
   * const file = await storage.download('avatars/user123/avatar.jpg');
   * console.log('Размер файла:', file.size, 'байт');
   * // file.buffer содержит бинарные данные
   * ```
   */
  download(path: string, options?: DownloadOptions): Promise<DownloadResult>;

  /**
   * Удалить файл из хранилища
   *
   * @param path - Путь к файлу
   * @returns true если файл был удален
   *
   * @example
   * ```typescript
   * const deleted = await storage.delete('avatars/user123/old-avatar.jpg');
   * console.log(deleted ? 'Файл удален' : 'Файл не найден');
   * ```
   */
  delete(path: string): Promise<boolean>;

  /**
   * Удалить несколько файлов одновременно
   *
   * @param paths - Пути к файлам
   * @returns Количество удаленных файлов
   *
   * @example
   * ```typescript
   * const deletedCount = await storage.deleteMany([
   *   'temp/file1.txt',
   *   'temp/file2.txt'
   * ]);
   * console.log(`Удалено ${deletedCount} файлов`);
   * ```
   */
  deleteMany(paths: string[]): Promise<number>;

  /**
   * Проверить существование файла
   *
   * @param path - Путь к файлу
   * @returns true если файл существует
   *
   * @example
   * ```typescript
   * if (await storage.exists('avatars/user123/avatar.jpg')) {
   *   console.log('Аватар существует');
   * }
   * ```
   */
  exists(path: string): Promise<boolean>;

  /**
   * Получить метаданные файла
   *
   * @param path - Путь к файлу
   * @returns Метаданные файла или null
   *
   * @example
   * ```typescript
   * const metadata = await storage.getMetadata('documents/report.pdf');
   * if (metadata) {
   *   console.log('Размер:', metadata.size, 'MIME:', metadata.mimeType);
   * }
   * ```
   */
  getMetadata(path: string): Promise<FileMetadata | null>;

  /**
   * Скопировать файл
   *
   * @param sourcePath - Исходный путь
   * @param options - Опции копирования
   * @returns URL скопированного файла
   *
   * @example
   * ```typescript
   * const newUrl = await storage.copy('avatars/user123/avatar.jpg', {
   *   destination: 'avatars/user123/avatar-backup.jpg'
   * });
   * ```
   */
  copy(sourcePath: string, options: CopyOptions): Promise<string>;

  /**
   * Переместить файл
   *
   * @param sourcePath - Исходный путь
   * @param options - Опции перемещения
   * @returns URL перемещенного файла
   *
   * @example
   * ```typescript
   * const newUrl = await storage.move('temp/upload.jpg', {
   *   destination: 'avatars/user123/avatar.jpg'
   * });
   * ```
   */
  move(sourcePath: string, options: MoveOptions): Promise<string>;

  /**
   * Найти файлы по критериям
   *
   * @param options - Опции поиска
   * @returns Результаты поиска
   *
   * @example
   * ```typescript
   * const result = await storage.listFiles({
   *   prefix: 'avatars/user123/',
   *   maxKeys: 10
   * });
   *
   * result.files.forEach(file => {
   *   console.log(`${file.path}: ${file.size} bytes`);
   * });
   * ```
   */
  listFiles(options?: ListFilesOptions): Promise<ListFilesResult>;

  /**
   * Создать подписанный URL для временного доступа
   *
   * @param path - Путь к файлу
   * @param expiresInSeconds - Время жизни URL в секундах
   * @param options - Дополнительные опции
   * @returns Подписанный URL
   *
   * @example
   * ```typescript
   * const signedUrl = await storage.getSignedUrl(
   *   'private/documents/secret.pdf',
   *   3600 // 1 час
   * );
   * // Отправить signedUrl пользователю для скачивания
   * ```
   */
  getSignedUrl(path: string, expiresInSeconds: number, options?: DownloadOptions): Promise<string>;

  /**
   * Проверить доступность хранилища
   *
   * @returns true если хранилище доступно
   */
  isAvailable(): Promise<boolean>;
}