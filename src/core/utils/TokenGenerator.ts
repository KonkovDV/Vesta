import { randomBytes } from 'node:crypto';

/**
 * TokenGenerator — утилита для генерации криптостойких токенов.
 *
 * Layer: Core (utils)
 *
 * Используется для API-ключей, одноразовых токенов и других
 * секретных значений. Не использовать для человеко-читаемых ID —
 * для этого есть IdGenerator.
 */
export function generateSecureToken(length: number = 32): string {
  if (!Number.isFinite(length) || length <= 0) {
    throw new Error('generateSecureToken: length must be a positive finite number');
  }

  // Каждый байт будет закодирован в два hex-символа, поэтому итоговая строка
  // будет иметь длину length * 2.
  const buffer = randomBytes(length);
  return buffer.toString('hex');
}