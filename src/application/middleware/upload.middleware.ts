import multer from 'multer';
import * as path from 'path';
import * as core from 'express-serve-static-core';
type RequestHandler = core.RequestHandler;

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.docx', '.csv', '.txt', '.json', '.xml',
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

function hasPathTraversal(filename: string): boolean {
  return filename.includes('..') || filename.includes('\0');
}

/**
 * Creates a multer middleware for handling file uploads.
 * Uses memory storage to keep files in RAM (buffer) for processing.
 *
 * Security hardening:
 * - Extension allowlist (rejects unlisted file types)
 * - Path traversal prevention (rejects `..` and NUL bytes)
 * - 10 MB file size limit
 */
export function createUploadMiddleware(): RequestHandler {
  const storage = multer.memoryStorage();

  const upload = multer({
    storage,
    limits: {
      fileSize: MAX_FILE_SIZE_BYTES,
      files: 1,
    },
    fileFilter: (_req, file, cb) => {
      const originalName = file.originalname ?? '';
      if (hasPathTraversal(originalName)) {
        cb(new Error('Invalid filename'));
        return;
      }

      const ext = path.extname(originalName).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        cb(new Error(`File type not allowed: ${ext}`));
        return;
      }

      cb(null, true);
    },
  });

  return upload.single('file');
}
