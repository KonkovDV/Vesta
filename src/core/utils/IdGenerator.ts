import { randomBytes, randomUUID } from 'node:crypto';

/**
 * IdGenerator — централизованный генератор криптостойких идентификаторов.
 *
 * Layer: Core (utils)
 *
 * Назначение:
 * - единая точка для генерации UUID v4;
 * - безопасные случайные строки для доменных/инфраструктурных идентификаторов;
 * - отсутствие зависимости от Math.random() для любых ID.
 */
export class IdGenerator {
  /**
   * Сгенерировать UUID v4 с использованием crypto.randomUUID().
   */
  static generate(): string {
    return randomUUID();
  }

  /**
   * Сгенерировать UUID v4 с префиксом, разделённым символом "_".
   *
   * Формат: "<prefix>_<uuid-v4>".
   */
  static generateWithPrefix(prefix: string): string {
    const id = IdGenerator.generate();
    if (!prefix) {
      return id;
    }
    return `${prefix}_${id}`;
  }

  /**
   * Сгенерировать криптостойкую случайную строку фиксированной длины.
   *
   * По умолчанию использует алфавит [0-9a-zA-Z], совместимый с EntityIdSchema.
   * Подходит для генерации компактных ID, не являющихся секретными токенами.
   *
   * Для секретных токенов используйте TokenGenerator.generateSecureToken().
   */
  static generateRandomString(
    length: number,
    alphabet: string = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ): string {
    if (length <= 0) {
      throw new Error('IdGenerator.generateRandomString: length must be positive');
    }
    if (!alphabet || alphabet.length === 0) {
      throw new Error('IdGenerator.generateRandomString: alphabet must not be empty');
    }

    const result: string[] = [];
    const alphabetLength = alphabet.length;

    // Используем randomBytes и равномерно отображаем байты в диапазон [0, alphabetLength).
    // Для простоты допускаем небольшое смещение распределения при длине алфавита,
    // не делящей 256, так как идентификаторы не используются как криптографические ключи.
    const bytes = randomBytes(length);

    for (let i = 0; i < length; i++) {
      const index = bytes[i] % alphabetLength;
      result.push(alphabet[index]);
    }

    return result.join('');
  }
}