declare module 'compression' {
  import type { RequestHandler } from 'express';

  export interface CompressionOptions {
    // Разрешаем любые опции, чтобы не ограничивать фактическую конфигурацию.
    [key: string]: unknown;
  }

  export default function compression(options?: CompressionOptions): RequestHandler;
}