/**
 * Базовые типы для всей архитектуры
 * Layer: Core (types, protocols, contracts)
 * 
 * Содержит фундаментальные типы доменного дизайна:
 * - EntityId: уникальные идентификаторы сущностей
 * - Timestamp: неизменяемые временные метки
 * - Domain Event интерфейсы
 * 
 * Принципы:
 * - Core не зависит от внешних слоёв
 * - Иммутабельность для Value Objects
 * - Типобезопасность через TypeScript
 */

import { z } from 'zod';
import { IdGenerator } from './utils/IdGenerator';

// ============================================================================
// Value Objects для базовых типов
// ============================================================================

/**
 * Строка идентификатора сущности.
 * Допускает символы 0-9, a-z, A-Z и подчеркивание "_".
 *
 * Примечания:
 * - Случайные идентификаторы, создаваемые EntityId.random(),
 *   по-прежнему используют компактный Base62 без подчеркиваний.
 * - Подчеркивания чаще всего используются на доменном уровне
 *   для префиксов (например, user_, system_, bot_).
 */
const ENTITY_ID_PATTERN = /^[0-9a-zA-Z_]+$/;

// Schema для валидации EntityId
export const EntityIdSchema = z.string()
  .min(1, 'EntityId не может быть пустой строкой')
  .regex(
    ENTITY_ID_PATTERN,
    'EntityId может содержать только символы 0-9, a-z, A-Z и символ подчеркивания "_"'
  );

/**
 * Timestamp в ISO 8601 формате с миллисекундами
 * Обеспечивает точный и универсальный способ работы со временем
 */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Schema для валидации Timestamp
export const TimestampSchema = z.string()
  .regex(TIMESTAMP_PATTERN, 'Timestamp должен быть в формате ISO 8601 с миллисекундами (например, 2025-11-01T13:40:49.987Z)');

// ============================================================================
// Value Object классы
// ============================================================================

/**
 * EntityId - неизменяемый идентификатор сущности
 * Обеспечивает типобезопасность и валидацию на уровне типов
 */
export class EntityId {
  public readonly value: string;

  constructor(value: string) {
    const parsed = EntityIdSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Невалидный EntityId: ${parsed.error.issues[0]?.message || value}`);
    }
    this.value = parsed.data;
  }

  /**
   * Создает новый EntityId со случайным значением
   */
  static random(): EntityId {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const value = IdGenerator.generateRandomString(12, chars);
    return new EntityId(value);
  }

  /**
   * Создает EntityId из строки после валидации
   */
  static fromString(value: string): EntityId {
    return new EntityId(value);
  }

  /**
   * Сравнивает два EntityId на равенство
   */
  equals(other: EntityId): boolean {
    return this.value === other.value;
  }

  /**
   * Приведение к строке
   */
  toString(): string {
    return this.value;
  }

  /**
   * JSON сериализация
   */
  toJSON(): string {
    return this.value;
  }

  /**
   * Совместимость со старыми вызовами
   */
  toValue(): string {
    return this.value;
  }
}

/**
 * Timestamp - неизменяемая временная метка
 * Гарантирует правильный формат и консистентность
 */
export class Timestamp {
  public readonly value: string;

  constructor(value: string) {
    const parsed = TimestampSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Невалидный Timestamp: ${parsed.error.issues[0]?.message || value}`);
    }
    this.value = parsed.data;
  }

  /**
   * Создает Timestamp для текущего момента
   */
  static now(): Timestamp {
    return new Timestamp(new Date().toISOString());
  }

  /**
   * Создает Timestamp из строки после валидации
   */
  static fromString(value: string): Timestamp {
    return new Timestamp(value);
  }

  /**
   * Создает Timestamp из Date объекта
   */
  static fromDate(date: Date): Timestamp {
    return new Timestamp(date.toISOString());
  }

  /**
   * Сравнивает два Timestamp на равенство
   */
  equals(other: Timestamp): boolean {
    return this.value === other.value;
  }

  /**
   * Проверяет, что данный Timestamp раньше другого
   */
  isBefore(other: Timestamp): boolean {
    return new Date(this.value) < new Date(other.value);
  }

  /**
   * Проверяет, что данный Timestamp позже другого
   */
  isAfter(other: Timestamp): boolean {
    return new Date(this.value) > new Date(other.value);
  }

  /**
   * Приведение к Date объекту
   */
  toDate(): Date {
    return new Date(this.value);
  }

  /**
   * Приведение к строке
   */
  toString(): string {
    return this.value;
  }

  /**
   * JSON сериализация
   */
  toJSON(): string {
    return this.value;
  }
}

// ============================================================================
// TypeScript типы для упрощения использования
// ============================================================================

export type EntityIdType = EntityId;
export type TimestampType = Timestamp;

// ============================================================================
// Утилиты для работы с типами
// ============================================================================

/**
 * Создает EntityId из строки с валидацией
 */
export function createEntityId(value: string): EntityId {
  return EntityId.fromString(value);
}

/**
 * Создает EntityId со случайным значением
 */
export function randomEntityId(): EntityId {
  return EntityId.random();
}

/**
 * Создает Timestamp для текущего момента
 */
export function now(): Timestamp {
  return Timestamp.now();
}

/**
 * Создает Timestamp из Date объекта
 */
export function createTimestamp(date: Date): Timestamp {
  return Timestamp.fromDate(date);
}

/**
 * Создает Timestamp из строки после валидации
 */
export function parseTimestamp(value: string): Timestamp {
  return Timestamp.fromString(value);
}