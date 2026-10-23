/**
 * FileProcessingService (stub) — доменный сервис-заглушка
 * Layer: Domain
 *
 * Минимальная обработка загрузки файлов, достаточная для компиляции и базового поведения.
 * Совместим с вызовами ChatController.uploadFile().
 */

import { IdGenerator } from '../../core/utils/IdGenerator';

/**
 * Domain-level типы для файлового сервиса.
 * Не привязаны к HTTP/Protocol контрактам.
 */
export type DomainMessageAttachmentType =
  | 'textFile'
  | 'imageFile'
  | 'pdfFile'
  | 'audioFile';

export interface DomainFileUploadInput {
  file?: {
    buffer?: Buffer;
    originalname?: string;
    mimetype?: string;
    size?: number;
    fieldname?: string;
    filename?: string;
    path?: string;
    stream?: unknown;
  };
  processAsImages?: boolean;
}

export interface DomainFileUploadResult {
  id: string;
  type: DomainMessageAttachmentType;
  name: string;
  size: number;
  mimeType: string;
  processedAsImages: boolean;
  content?: string;
  base64Data?: string;
}

function detectAttachmentType(mime?: string): DomainMessageAttachmentType {
  if (!mime) return 'textFile';
  if (mime.startsWith('image/')) return 'imageFile';
  if (mime === 'application/pdf') return 'pdfFile';
  if (mime.startsWith('audio/')) return 'audioFile';
  if (mime.startsWith('text/') || mime === 'application/json') return 'textFile';
  return 'textFile';
}

export class FileProcessingService {
  /**
   * Обрабатывает загрузку файла.
   * В проде здесь будет валидация, преобразование, и сохранение в storage.
   */
  async processFileUpload(
    req: DomainFileUploadInput,
    userId: string
  ): Promise<DomainFileUploadResult> {
    // В ChatController ожидается, что req.file приходит от multer (Express)
    // Типизируем как Multer.File на уровне использования, чтобы избежать зависимости от multer в домене.
    const fileAny = (req as { file?: { buffer: Buffer; originalname: string; mimetype: string; size: number; fieldname?: string; filename?: string; path?: string; stream?: unknown } }).file;
 
    const id = IdGenerator.generateWithPrefix('upload');
    const name: string =
      fileAny?.originalname ??
      `file_${Date.now()}`;
    const mimeType: string = (fileAny?.mimetype as string) ?? 'application/octet-stream';
    const size: number = (fileAny?.size as number) ?? 0;

    const type: DomainMessageAttachmentType = detectAttachmentType(mimeType);

    // Заглушка содержимого
    let content: string | undefined;
    let base64Data: string | undefined;
    if (type === 'textFile') {
      // Если есть буфер — декодируем текст как UTF‑8
      if (fileAny?.buffer instanceof Buffer) {
        content = fileAny.buffer.toString('utf-8').slice(0, 200_000); // ограничим до 200К символов
      }
    } else if (type === 'imageFile' || type === 'audioFile' || type === 'pdfFile') {
      if (fileAny?.buffer instanceof Buffer) {
        base64Data = fileAny.buffer.toString('base64');
      }
    }

    const response: DomainFileUploadResult = {
      id,
      type,
      name,
      size,
      mimeType,
      processedAsImages: !!req.processAsImages,
      content,
      base64Data
    };

    return response;
  }
}