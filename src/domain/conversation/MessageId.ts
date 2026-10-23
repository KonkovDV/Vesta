/**
 * MessageId - Value Object для уникального идентификатора сообщения
 * Layer: Domain (бизнес-логика)
 * 
 * Инкапсулирует логику валидации и создания идентификаторов сообщений.
 * Обеспечивает типобезопасность на уровне домена.
 * 
 * Принципы DDD:
 * - Value Object - неизменяемое значение без идентичности
 * - Равенство по значению, а не по ссылке
 * - Самовалидация при создании
 */

import { EntityId } from '../../core/types';
import { IdGenerator } from '../../core/utils/IdGenerator';

/**
 * MessageId - специализированный идентификатор для сообщений
 * 
 * Наследуется от базового EntityId, но добавляет доменную семантику
 * для сообщений в беседах.
 */
export class MessageId extends EntityId {
  /**
   * Приватный конструктор для принудительного использования фабричных методов
   */
  private constructor(value: string) {
    super(value);
  }

  /**
   * Создать новый случайный MessageId
   *
   * @returns Новый уникальный идентификатор сообщения
   *
   * @example
   * ```typescript
   * const messageId = MessageId.create();
   * console.log(messageId.toString()); // "msg_1635723456789_abc123def4"
   * ```
   */
  static create(): MessageId {
    const timestamp = Date.now();
    const random = IdGenerator.generateRandomString(9);
    const value = `msg_${timestamp}_${random}`;
    return new MessageId(value);
  }

  /**
   * Создать MessageId из строки
   * 
   * @param value - Строковое представление ID
   * @returns MessageId после валидации
   * @throws Error если формат невалиден
   * 
   * @example
   * ```typescript
   * const messageId = MessageId.fromString("msg_1234567890_abc123");
   * ```
   */
  static fromString(value: string): MessageId {
    // Валидация происходит в родительском EntityId конструкторе
    const baseId = EntityId.fromString(value);
    return new MessageId(baseId.value);
  }

  /**
   * Проверить, является ли строка валидным MessageId
   * 
   * @param value - Строка для проверки
   * @returns true если валидна, false иначе
   * 
   * @example
   * ```typescript
   * if (MessageId.isValid("msg_1234567890_abc123")) {
   *   // ID валиден
   * }
   * ```
   */
  static isValid(value: string): boolean {
    try {
      MessageId.fromString(value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Сравнить два MessageId на равенство
   * 
   * @param other - Другой MessageId для сравнения
   * @returns true если идентификаторы равны
   * 
   * @example
   * ```typescript
   * const id1 = MessageId.fromString("msg_1234567890_abc123");
   * const id2 = MessageId.fromString("msg_1234567890_abc123");
   * console.log(id1.equals(id2)); // true
   * ```
   */
  equals(other: MessageId): boolean {
    return super.equals(other);
  }

  /**
   * Получить строковое представление для логирования
   * 
   * @returns Строка в формате "MessageId(value)"
   */
  toString(): string {
    return `MessageId(${this.value})`;
  }

  /**
   * Получить чистое значение (без префикса) для API ответов
   * 
   * @returns Строковое значение ID
   */
  toValue(): string {
    return this.value;
  }

  /**
   * JSON сериализация - возвращает чистое значение
   * 
   * @returns Строковое значение ID
   */
  toJSON(): string {
    return this.value;
  }

  /**
   * Извлечь timestamp из MessageId (если возможно)
   * 
   * @returns Timestamp или null если не удалось извлечь
   */
  getTimestamp(): number | null {
    const match = this.value.match(/^msg_(\d+)_/);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Проверить, что сообщение было создано недавно
   * 
   * @param withinMs - Период в миллисекундах
   * @returns true если сообщение создано в указанный период
   */
  isRecent(withinMs: number = 3600000): boolean {
    const timestamp = this.getTimestamp();
    if (!timestamp) return false;
    return Date.now() - timestamp <= withinMs;
  }
}

/**
 * Type guard для проверки, что значение - это MessageId
 * 
 * @param value - Значение для проверки
 * @returns true если value является MessageId
 * 
 * @example
 * ```typescript
 * if (isMessageId(someValue)) {
 *   // TypeScript теперь знает, что someValue это MessageId
 *   console.log(someValue.toValue());
 * }
 * ```
 */
export function isMessageId(value: unknown): value is MessageId {
  return value instanceof MessageId;
}

/**
 * Утилита для создания MessageId из строки с обработкой ошибок
 * 
 * @param value - Строковое значение
 * @returns MessageId или null если невалидно
 * 
 * @example
 * ```typescript
 * const id = tryCreateMessageId("msg_1234567890_abc123");
 * if (id) {
 *   // Используем id
 * } else {
 *   // Обрабатываем ошибку
 * }
 * ```
 */
export function tryCreateMessageId(value: string): MessageId | null {
  try {
    return MessageId.fromString(value);
  } catch {
    return null;
  }
}