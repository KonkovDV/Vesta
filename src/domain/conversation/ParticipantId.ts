/**
 * ParticipantId - Value Object для уникального идентификатора участника беседы
 * Layer: Domain (бизнес-логика)
 * 
 * Инкапсулирует логику валидации и создания идентификаторов участников.
 * Обеспечивает типобезопасность на уровне домена.
 * 
 * Принципы DDD:
 * - Value Object - неизменяемое значение без идентичности
 * - Равенство по значению, а не по ссылке
 * - Самовалидация при создании
 */

import { EntityId } from '../../core/types';

/**
 * ParticipantId - специализированный идентификатор для участников беседы.
 *
 * Каноническая форма внутреннего значения:
 * - строка с префиксом "user_", "system_" или "bot_";
 * - далее "slug" из символов [0-9a-zA-Z_].
 *
 * Префикс является частью внутреннего значения (this.value) и
 * сериализации (toValue()/toJSON()).
 *
 * Наследуется от базового EntityId, но добавляет доменную семантику
 * для участников в беседах.
 */
export class ParticipantId extends EntityId {
  /**
   * Приватный конструктор для принудительного использования фабричных методов
   */
  private constructor(value: string) {
    super(value);
  }

  /**
   * Создать новый случайный ParticipantId
   * 
   * @returns Новый уникальный идентификатор участника
   * 
   * @example
   * ```typescript
   * const participantId = ParticipantId.create();
   * console.log(participantId.toString()); // "user_abc123def456"
   * ```
   */
  static create(): ParticipantId {
    const baseId = EntityId.random();
    return new ParticipantId(`user_${baseId.value}`);
  }

  /**
   * Создать ParticipantId из строки.
   *
   * Правила нормализации:
   * - если value уже начинается с префикса "user_", "system_" или "bot_",
   *   оно используется как каноническое значение;
   * - иначе к value добавляется префикс "user_" (т.е. пользовательский участник).
   *
   * Итоговое значение должно соответствовать EntityIdSchema
   * (разрешены символы 0-9, a-z, A-Z и "_").
   *
   * @param value - Строковое представление ID (со знакомым префиксом или без него)
   * @returns ParticipantId после валидации
   * @throws Error если формат невалиден
   *
   * @example
   * ```typescript
   * ParticipantId.fromString("owner_1");              // "user_owner_1"
   * ParticipantId.fromString("user_owner_1");         // "user_owner_1"
   * ParticipantId.fromString("system_notifications"); // "system_notifications"
   * ParticipantId.fromString("bot_support");          // "bot_support"
   * ```
   */
  static fromString(value: string): ParticipantId {
    const hasKnownPrefix =
      value.startsWith('user_') ||
      value.startsWith('system_') ||
      value.startsWith('bot_');

    const normalizedValue = hasKnownPrefix ? value : `user_${value}`;

    // Валидация происходит в родительском EntityId конструкторе
    const baseId = EntityId.fromString(normalizedValue);
    return new ParticipantId(baseId.value);
  }

  /**
   * Проверить, является ли строка валидным ParticipantId
   * 
   * @param value - Строка для проверки
   * @returns true если валидна, false иначе
   * 
   * @example
   * ```typescript
   * if (ParticipantId.isValid("user_abc123")) {
   *   // ID валиден
   * }
   * ```
   */
  static isValid(value: string): boolean {
    try {
      ParticipantId.fromString(value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Сравнить два ParticipantId на равенство
   * 
   * @param other - Другой ParticipantId для сравнения
   * @returns true если идентификаторы равны
   * 
   * @example
   * ```typescript
   * const id1 = ParticipantId.fromString("user_abc123");
   * const id2 = ParticipantId.fromString("user_abc123");
   * console.log(id1.equals(id2)); // true
   * ```
   */
  equals(other: ParticipantId): boolean {
    return super.equals(other);
  }

  /**
   * Получить строковое представление для логирования
   * 
   * @returns Строка в формате "ParticipantId(value)"
   */
  toString(): string {
    return `ParticipantId(${this.value})`;
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
   * Извлечь базовый ID без префикса user_
   * 
   * @returns Чистый ID без префикса
   */
  getBaseId(): string {
    return this.value.replace(/^user_/, '');
  }

  /**
   * Проверить, является ли участник системным
   * 
   * @returns true если это системный участник
   */
  isSystem(): boolean {
    return this.value.startsWith('system_');
  }

  /**
   * Проверить, является ли участник ботом
   * 
   * @returns true если это бот
   */
  isBot(): boolean {
    return this.value.startsWith('bot_');
  }

  /**
   * Создать системный ParticipantId
   * 
   * @param systemName - Название системного участника
   * @returns ParticipantId для системного пользователя
   */
  static system(systemName: string): ParticipantId {
    return new ParticipantId(`system_${systemName}`);
  }

  /**
   * Создать ParticipantId для бота
   * 
   * @param botName - Название бота
   * @returns ParticipantId для бота
   */
  static bot(botName: string): ParticipantId {
    return new ParticipantId(`bot_${botName}`);
  }
}

/**
 * Type guard для проверки, что значение - это ParticipantId
 * 
 * @param value - Значение для проверки
 * @returns true если value является ParticipantId
 * 
 * @example
 * ```typescript
 * if (isParticipantId(someValue)) {
 *   // TypeScript теперь знает, что someValue это ParticipantId
 *   console.log(someValue.toValue());
 * }
 * ```
 */
export function isParticipantId(value: unknown): value is ParticipantId {
  return value instanceof ParticipantId;
}

/**
 * Утилита для создания ParticipantId из строки с обработкой ошибок
 * 
 * @param value - Строковое значение
 * @returns ParticipantId или null если невалидно
 * 
 * @example
 * ```typescript
 * const id = tryCreateParticipantId("user_abc123");
 * if (id) {
 *   // Используем id
 * } else {
 *   // Обрабатываем ошибку
 * }
 * ```
 */
export function tryCreateParticipantId(value: string): ParticipantId | null {
  try {
    return ParticipantId.fromString(value);
  } catch {
    return null;
  }
}