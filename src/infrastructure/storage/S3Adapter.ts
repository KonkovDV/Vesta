/**
 * S3Adapter - адаптер для Amazon S3
 * Layer: Infrastructure
 *
 * Реализует IFileStorage интерфейс для работы с Amazon S3.
 * Инкапсулирует специфику S3 и предоставляет унифицированный интерфейс.
 *
 * @example
 * ```typescript
 * import { getConfig } from '../../config';
 *
 * const cfg = getConfig();
 * const adapter = new S3Adapter({
 *   accessKeyId: cfg.AWS_ACCESS_KEY_ID,
 *   secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY,
 *   region: cfg.AWS_REGION ?? 'us-east-1',
 *   bucket: cfg.AWS_S3_BUCKET ?? 'my-bucket'
 * });
 *
 * const result = await adapter.upload(fileData, 'avatars/user123.jpg');
 * console.log('Файл загружен:', result.url);
 * ```
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand, HeadObjectCommand, ListObjectsV2Command, GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { IFileStorage, FileData, FileMetadata, UploadOptions, DownloadOptions, UploadResult, DownloadResult, CopyOptions, MoveOptions, ListFilesOptions, ListFilesResult, FileInfo } from '../../domain/storage/IFileStorage';
import { Timestamp, now } from '../../core/types';
import { getConfig } from '../../config';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

/**
 * Нормализует пользовательские метаданные к формату Record<string,string>
 */
function mapMetadata(input?: Record<string, unknown> | null): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Type guard для проверки структуры S3 ошибки
function isS3Error(error: unknown): error is {
  name?: string;
  $metadata?: { httpStatusCode?: number };
} {
  return error !== null &&
         typeof error === 'object' &&
         'name' in error;
}

/**
 * Конфигурация S3 адаптера
 */
export interface S3AdapterConfig {
  /** AWS Access Key ID */
  accessKeyId: string;
  /** AWS Secret Access Key */
  secretAccessKey: string;
  /** AWS Region */
  region: string;
  /** Имя S3 бакета */
  bucket: string;
  /** Базовый URL для публичного доступа */
  baseUrl?: string;
  /** Префикс для всех ключей */
  keyPrefix?: string;
  /** Настройки подписи URL */
  signedUrlExpirySeconds?: number;
  /** Максимальный размер файла в байтах */
  maxFileSizeBytes?: number;
  /** Разрешенные MIME типы */
  allowedMimeTypes?: string[];
}

/**
 * S3Adapter - реализация IFileStorage для Amazon S3
 */
export class S3Adapter implements IFileStorage {
  private s3Client: S3Client;
  private config: S3AdapterConfig;

  constructor(config: S3AdapterConfig, private readonly logger?: IStructuredLogger) {
    this.config = {
      signedUrlExpirySeconds: 3600, // 1 час
      maxFileSizeBytes: 100 * 1024 * 1024, // 100MB
      allowedMimeTypes: ['*'], // Все типы по умолчанию
      ...config,
    };

    this.s3Client = new S3Client({
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  /**
   * Добавить префикс к ключу
   */
  private addPrefix(key: string): string {
    return this.config.keyPrefix ? `${this.config.keyPrefix}/${key}` : key;
  }

  /**
   * Построить публичный URL для файла
   */
  private buildPublicUrl(key: string): string {
    if (this.config.baseUrl) {
      return `${this.config.baseUrl}/${key}`;
    }
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${key}`;
  }

  /**
   * Проверить размер файла
   */
  private validateFileSize(size: number): void {
    if (this.config.maxFileSizeBytes && size > this.config.maxFileSizeBytes) {
      throw new Error(`File size ${size} bytes exceeds maximum allowed size ${this.config.maxFileSizeBytes} bytes`);
    }
  }

  /**
   * Проверить MIME тип
   */
  private validateMimeType(mimeType: string): void {
    if (this.config.allowedMimeTypes && !this.config.allowedMimeTypes.includes('*')) {
      if (!this.config.allowedMimeTypes.includes(mimeType)) {
        throw new Error(`MIME type ${mimeType} is not allowed. Allowed types: ${this.config.allowedMimeTypes.join(', ')}`);
      }
    }
  }

  /**
   * Загрузить файл в S3
   */
  async upload(fileData: FileData, path: string, options?: UploadOptions): Promise<UploadResult> {
    try {
      // Валидация
      this.validateFileSize(fileData.size);
      this.validateMimeType(fileData.mimeType);

      const key = this.addPrefix(path);

      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: fileData.buffer,
        ContentType: options?.mimeType || fileData.mimeType,
        ACL: (options?.acl === 'public-read' ? 'public-read' :
             options?.acl === 'authenticated-read' ? 'authenticated-read' : 'private'),
        Metadata: mapMetadata(options?.metadata ?? undefined),
        ...(options?.encryption && {
          ServerSideEncryption: options.encryption.algorithm === 'AES256' ? 'AES256' : 'aws:kms',
          SSEKMSKeyId: options.encryption.key,
        }),
      });

      const response = await this.s3Client.send(command);

      return {
        url: this.buildPublicUrl(key),
        etag: response.ETag || '',
        versionId: response.VersionId,
        uploadedAt: now(),
      };

    } catch (error) {
      console.error(`[S3] Upload error for path ${path}:`, error);
      throw new Error(`Failed to upload file to S3: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Загрузить файл из S3
   */
  async download(path: string, options?: DownloadOptions): Promise<DownloadResult> {
    try {
      const key = this.addPrefix(path);

      const command = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Range: options?.range ? `bytes=${options.range.start}-${options.range.end || ''}` : undefined,
        VersionId: options?.versionId,
        ...(options?.encryption && {
          SSECustomerAlgorithm: options.encryption.algorithm,
          SSECustomerKey: options.encryption.key,
        }),
      });

      const response: GetObjectCommandOutput = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error('Empty response body from S3');
      }

      // Чтение тела ответа
      const buffer = Buffer.from(await response.Body.transformToByteArray());

      return {
        buffer,
        filename: path.split('/').pop() || 'file',
        mimeType: response.ContentType || 'application/octet-stream',
        size: buffer.length,
        etag: response.ETag || '',
        lastModified: response.LastModified ? Timestamp.fromDate(response.LastModified) : now(),
        versionId: response.VersionId,
        metadata: mapMetadata(response.Metadata),
      };

    } catch (error) {
      console.error(`[S3] Download error for path ${path}:`, error);
      throw new Error(`Failed to download file from S3: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Удалить файл из S3
   */
  async delete(path: string): Promise<boolean> {
    try {
      const key = this.addPrefix(path);

      const command = new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;

    } catch (error) {
      console.error(`[S3] Delete error for path ${path}:`, error);
      return false;
    }
  }

  /**
   * Удалить несколько файлов одновременно
   */
  async deleteMany(paths: string[]): Promise<number> {
    let deletedCount = 0;

    // S3 не поддерживает массовое удаление в одном запросе как некоторые другие хранилища
    // Поэтому удаляем по одному
    for (const path of paths) {
      try {
        await this.delete(path);
        deletedCount++;
      } catch (error) {
        this.logger?.error(`[S3] Failed to delete ${path}`, { error: String(error) });
      }
    }

    return deletedCount;
  }

  /**
   * Проверить существование файла
   */
  async exists(path: string): Promise<boolean> {
    try {
      const key = this.addPrefix(path);

      const command = new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;

    } catch (error: unknown) {
      // S3 возвращает NotFound для несуществующих объектов
      if (isS3Error(error) &&
          (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404)) {
        return false;
      }
      console.error(`[S3] Exists check error for path ${path}:`, error);
      return false;
    }
  }

  /**
   * Получить метаданные файла
   */
  async getMetadata(path: string): Promise<FileMetadata | null> {
    try {
      const key = this.addPrefix(path);

      const command = new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      return {
        size: response.ContentLength || 0,
        mimeType: response.ContentType || 'application/octet-stream',
        createdAt: response.LastModified ? Timestamp.fromDate(response.LastModified) : now(),
        modifiedAt: response.LastModified ? Timestamp.fromDate(response.LastModified) : now(),
        etag: response.ETag,
        checksum: response.ChecksumSHA256,
        customMetadata: mapMetadata(response.Metadata),
      };

    } catch (error: unknown) {
      if (isS3Error(error) &&
          (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404)) {
        return null;
      }
      console.error(`[S3] Get metadata error for path ${path}:`, error);
      return null;
    }
  }

  /**
   * Скопировать файл
   */
  async copy(sourcePath: string, options: CopyOptions): Promise<string> {
    try {
      const sourceKey = this.addPrefix(sourcePath);
      const destinationKey = this.addPrefix(options.destination);

      const command = new CopyObjectCommand({
        Bucket: this.config.bucket,
        CopySource: `${this.config.bucket}/${sourceKey}`,
        Key: destinationKey,
        ACL: options.acl === 'public-read' ? 'public-read' :
             options.acl === 'authenticated-read' ? 'authenticated-read' : 'private',
        Metadata: mapMetadata(options.metadata ?? undefined),
      });

      await this.s3Client.send(command);

      return this.buildPublicUrl(destinationKey);

    } catch (error) {
      console.error(`[S3] Copy error from ${sourcePath} to ${options.destination}:`, error);
      throw new Error(`Failed to copy file in S3: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Переместить файл (копирование + удаление)
   */
  async move(sourcePath: string, options: MoveOptions): Promise<string> {
    const newUrl = await this.copy(sourcePath, options);
    await this.delete(sourcePath);
    return newUrl;
  }

  /**
   * Найти файлы по критериям
   */
  async listFiles(options?: ListFilesOptions): Promise<ListFilesResult> {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: options?.prefix ? this.addPrefix(options.prefix) : this.config.keyPrefix,
        MaxKeys: options?.maxKeys,
        ContinuationToken: options?.continuationToken,
      });

      const response = await this.s3Client.send(command);

      const files: FileInfo[] = (response.Contents || [])
        .filter(obj => typeof obj.Key === 'string' && typeof obj.Size === 'number')
        .map(obj => {
          const key = obj.Key as string;
          const size = obj.Size as number;
          return {
            path: key.replace(this.config.keyPrefix || '', '').replace(/^\//, ''),
            size,
            lastModified: obj.LastModified ? Timestamp.fromDate(obj.LastModified) : now(),
            etag: obj.ETag || '',
            mimeType: undefined, // S3 не возвращает MIME тип в списке
          };
        })
        .filter(file => {
          // Фильтр по расширению
          if (options?.extension) {
            return file.path.endsWith(`.${options.extension}`);
          }
          // Фильтр по MIME типу (приближенный, без реального определения)
          if (options?.mimeType) {
            // Простая проверка по расширению файла
            const ext = file.path.split('.').pop()?.toLowerCase();
            const mimeMap: Record<string, string> = {
              'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
              'gif': 'image/gif', 'pdf': 'application/pdf', 'txt': 'text/plain',
              'json': 'application/json', 'xml': 'application/xml'
            };
            return mimeMap[ext || ''] === options.mimeType;
          }
          return true;
        });

      return {
        files,
        continuationToken: response.NextContinuationToken,
        totalCount: response.KeyCount,
        isTruncated: response.IsTruncated || false,
      };

    } catch (error) {
      console.error(`[S3] List files error:`, error);
      return {
        files: [],
        totalCount: 0,
        isTruncated: false,
      };
    }
  }

  /**
   * Создать подписанный URL для временного доступа
   */
  async getSignedUrl(path: string, expiresInSeconds: number, options?: DownloadOptions): Promise<string> {
    try {
      const key = this.addPrefix(path);

      const command = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Range: options?.range ? `bytes=${options.range.start}-${options.range.end || ''}` : undefined,
        VersionId: options?.versionId,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: expiresInSeconds,
      });

      return signedUrl;

    } catch (error) {
      console.error(`[S3] Get signed URL error for path ${path}:`, error);
      throw new Error(`Failed to generate signed URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Проверить доступность S3
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Простая проверка - попытка получить список объектов
      const command = new ListObjectsV2Command({
        Bucket: this.config.bucket,
        MaxKeys: 1,
      });

      await this.s3Client.send(command);
      return true;

    } catch {
      return false;
    }
  }
}

/**
 * Фабричная функция для создания S3 адаптера
 */
/* duplicate mapMetadata removed: using top-level mapMetadata */

export function createS3Adapter(config: S3AdapterConfig): IFileStorage {
  return new S3Adapter(config);
}

/**
 * Фабричная функция для создания S3 адаптера из конфигурации приложения
 */
export function createS3AdapterFromEnv(): IFileStorage {
  const config = getConfig();

  const accessKeyId = config.AWS_ACCESS_KEY_ID;
  const secretAccessKey = config.AWS_SECRET_ACCESS_KEY;
  const region = config.AWS_REGION ?? 'us-east-1';
  const bucket = config.AWS_S3_BUCKET;

  if (!accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_S3_BUCKET environment variables are required',
    );
  }

  const signedUrlExpiryRaw = config.AWS_S3_SIGNED_URL_EXPIRY;
  const maxFileSizeRaw = config.AWS_S3_MAX_FILE_SIZE;
  const allowedMimeTypesRaw = config.AWS_S3_ALLOWED_MIME_TYPES;

  const signedUrlExpirySeconds =
    signedUrlExpiryRaw !== undefined && signedUrlExpiryRaw.length > 0
      ? Number.parseInt(signedUrlExpiryRaw, 10)
      : undefined;

  const maxFileSizeBytes =
    maxFileSizeRaw !== undefined && maxFileSizeRaw.length > 0
      ? Number.parseInt(maxFileSizeRaw, 10)
      : undefined;

  const allowedMimeTypes =
    allowedMimeTypesRaw && allowedMimeTypesRaw.length > 0
      ? allowedMimeTypesRaw
          .split(',')
          .map((mime) => mime.trim())
          .filter((mime) => mime.length > 0)
      : undefined;

  return new S3Adapter({
    accessKeyId,
    secretAccessKey,
    region,
    bucket,
    baseUrl: config.AWS_S3_BASE_URL,
    keyPrefix: config.AWS_S3_KEY_PREFIX,
    signedUrlExpirySeconds,
    maxFileSizeBytes,
    allowedMimeTypes,
  });
}