/**
 * ConversationId - Value Object для уникального идентификатора беседы
 * Layer: Domain (бизнес-логика)
 * 
 * Инкапсулирует логику валидации и создания идентификаторов бесед.
 * Обеспечивает типобезопасность на уровне домена.
 * 
 * Принципы DDD:
 * - Value Object - неизменяемое значение без идентичности
 * - Равенство по значению, а не по ссылке
 * - Самовалидация при создании
 */

import { EntityId } from '../../core/types';

/**
 * ConversationId - специализированный идентификатор для агрегата Conversation
 *
 * Наследуется от базового EntityId, но добавляет доменную семантику
 * и дополнительные методы валидации специфичные для бесед.
 *
 * Контракт:
 * - toValue() возвращает канонический идентификатор беседы, который следует
 *   использовать для DomainEvent.aggregateId, сериализации в БД и внешних протоколах.
 * - toString() возвращает логгерное представление вида "ConversationId(value)" и
 *   предназначен только для логирования и отладки.
 */
export class ConversationId extends EntityId {
  /**
   * Приватный конструктор для принудительного использования фабричных методов
   */
  private constructor(value: string) {
    super(value);
  }

  /**
   * Создать новый случайный ConversationId
   * 
   * @returns Новый уникальный идентификатор беседы
   * 
   * @example
   * ```typescript
   * const conversationId = ConversationId.create();
   * console.log(conversationId.toString()); // "aBc123XyZ456"
   * ```
   */
  static create(): ConversationId {
    const baseId = EntityId.random();
    return new ConversationId(baseId.value);
  }

  /**
   * Создать ConversationId из строки
   * 
   * @param value - Строковое представление ID
   * @returns ConversationId после валидации
   * @throws Error если формат невалиден
   * 
   * @example
   * ```typescript
   * const conversationId = ConversationId.fromString("abc123");
   * ```
   */
  static fromString(value: string): ConversationId {
    // Валидация происходит в родительском EntityId конструкторе
    const baseId = EntityId.fromString(value);
    return new ConversationId(baseId.value);
  }

  /**
   * Проверить, является ли строка валидным ConversationId
   * 
   * @param value - Строка для проверки
   * @returns true если валидна, false иначе
   * 
   * @example
   * ```typescript
   * if (ConversationId.isValid("abc123")) {
   *   // ID валиден
   * }
   * ```
   */
  static isValid(value: string): boolean {
    try {
      ConversationId.fromString(value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Сравнить два ConversationId на равенство
   * 
   * @param other - Другой ConversationId для сравнения
   * @returns true если идентификаторы равны
   * 
   * @example
   * ```typescript
   * const id1 = ConversationId.fromString("abc123");
   * const id2 = ConversationId.fromString("abc123");
   * console.log(id1.equals(id2)); // true
   * ```
   */
  equals(other: ConversationId): boolean {
    return super.equals(other);
  }

  /**
   * Получить строковое представление идентификатора для логирования.
   *
   * Формат: "ConversationId(value)".
   * ВАЖНО: это представление предназначено только для логов и диагностики и не должно
   * использоваться для хранения или сравнения идентификаторов (для этого есть toValue()).
   */
  toString(): string {
    return `ConversationId(${this.value})`;
  }

  /**
   * Получить каноническое «сырое» значение идентификатора беседы.
   *
   * Это значение:
   * - используется в DomainEvent.aggregateId;
   * - записывается в хранилища и внешние протоколы;
   * - передаётся во внешние API.
   *
   * @returns Строковое каноническое значение ID
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
}

/**
 * Type guard для проверки, что значение - это ConversationId
 * 
 * @param value - Значение для проверки
 * @returns true если value является ConversationId
 * 
 * @example
 * ```typescript
 * if (isConversationId(someValue)) {
 *   // TypeScript теперь знает, что someValue это ConversationId
 *   console.log(someValue.toValue());
 * }
 * ```
 */
export function isConversationId(value: unknown): value is ConversationId {
  return value instanceof ConversationId;
}

/**
 * Утилита для создания ConversationId из строки с обработкой ошибок
 * 
 * @param value - Строковое значение
 * @returns ConversationId или null если невалидно
 * 
 * @example
 * ```typescript
 * const id = tryCreateConversationId("abc123");
 * if (id) {
 *   // Используем id
 * } else {
 *   // Обрабатываем ошибку
 * }
 * ```
 */
export function tryCreateConversationId(value: string): ConversationId | null {
  try {
    return ConversationId.fromString(value);
  } catch {
    return null;
  }
}