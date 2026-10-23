/**
 * Базовый класс AggregateRoot для всех доменных агрегатов
 * Layer: Core (types, protocols, contracts)
 * 
 * Предоставляет фундаментальную функциональность для DDD агрегатов:
 * - Управление доменными событиями
 * - Версионирование для Event Sourcing
 * - Базовые операции агрегата
 * 
 * Принципы:
 * - AggregateRoot - это и сущность, и транзакционная граница
 * - Доменные события фиксируют все изменения состояния
 * - Версионирование обеспечивает согласованность в Event Sourcing
 */

import { EntityId } from '../types';
import { CorrelationIdProvider } from '../correlation/correlation';
import { IdGenerator } from '../utils/IdGenerator';

/**
 * Базовый контракт доменного события.
 *
 * Инварианты:
 * - aggregateId содержит каноническое значение идентификатора агрегата
 *   (EntityId.value / EntityId.toValue()).
 * - aggregateId НЕ должен содержать строковое представление из toString(),
 *   которое предназначено только для логирования.
 */
export interface DomainEvent {
  /** Уникальный идентификатор события */
  eventId: string;
  /** Тип события (например, 'MessageAdded') */
  type: string;
  /** Временная метка события */
  timestamp: Date;
  /** Идентификатор агрегата-источника */
  aggregateId: string;
  /** Версия агрегата на момент генерации события */
  aggregateVersion: number;
  /** Correlation ID для трассировки цепочки операций */
  correlationId: string;
  /** Опциональный causation ID */
  causationId?: string;
  /** Данные события */
  payload: Record<string, unknown>;
}

/**
 * Базовый интерфейс для всех доменных агрегатов
 */
export interface Aggregate {
  /** Уникальный идентификатор агрегата */
  id: EntityId;
  /** Версия агрегата (для Event Sourcing) */
  version: number;
  /** Список доменных событий, сгенерированных агрегатом */
  getEvents(): DomainEvent[];
  /** Применяет доменное событие к агрегату */
  applyEvent(event: DomainEvent): void;
  /** Проверяет, что агрегат имеет некоммитченные изменения */
  hasChanges(): boolean;
  /** Очищает список некоммитченных событий после сохранения */
  clearEvents(): void;
}

/**
 * Базовый класс для всех доменных агрегатов
 *
 * Особенности:
 * - Автоматическая генерация доменных событий
 * - Версионирование для Event Sourcing
 * - Защита от некорректных операций
 * - TypeScript типобезопасность
 *
 * Контракт идентификаторов:
 * - this.id должен быть ID-Value Object, совместимым с EntityId (имеет метод toValue()).
 * - Каноническое значение идентификатора агрегата — результат this.id.toValue().
 * - Каноническое значение используется в DomainEvent.aggregateId, для генерации eventId
 *   и сериализации в хранилищах событий.
 * - Строковое представление из toString() предназначено только для логирования и не
 *   должно использоваться для хранения или сравнения идентификаторов.
 */
export abstract class AggregateRoot<TProps = Record<string, unknown>> implements Aggregate {
  /** Уникальный идентификатор агрегата */
  public readonly id: EntityId;
  
  /** Текущая версия агрегата */
  protected _version: number;
  
  /** Список некоммитченных доменных событий */
  private _events: DomainEvent[] = [];

  /** Свойства агрегата (неизменяемые) */
  protected readonly props: Readonly<TProps>;

  constructor(id: EntityId, props: TProps, initialVersion = 1) {
    this.id = id;
    this.props = Object.freeze({ ...props });
    this._version = initialVersion;
  }

  /**
   * Получить каноническое строковое значение идентификатора агрегата.
   *
   * По контракту this.id должен быть Value Object, совместимым с EntityId и
   * предоставляющим метод toValue(). Это значение используется в DomainEvent.aggregateId,
   * генерации eventId и сериализации в хранилище событий.
   * Для обратной совместимости, если toValue отсутствует, используется toString().
   */
  private getAggregateIdValue(): string {
    const id = this.id as EntityId & { toValue?: () => string };
    if (typeof id.toValue === 'function') {
      return id.toValue();
    }
    return this.id.toString();
  }

  /**
   * Внутренний метод для безопасного обновления readonly frozen props
   * Используется только внутри AggregateRoot для Event Sourcing
   * 
   * @param newProps - Новые свойства агрегата (полная замена)
   * @internal
   */
  protected setProps(newProps: TProps): void {
    // Безопасная внутренняя мутация для Event Sourcing
    // props остаются readonly для внешнего использования
    // @ts-expect-error - Intentional mutation of readonly property for Event Sourcing hydration
    this.props = Object.freeze({ ...newProps });
  }

  /** Получить текущую версию агрегата */
  get version(): number {
    return this._version;
  }

  /** Получить все доменные события агрегата */
  getEvents(): DomainEvent[] {
    return [...this._events];
  }

  /** Проверить, есть ли некоммитченные изменения */
  hasChanges(): boolean {
    return this._events.length > 0;
  }

  /** Очистить список событий после коммита */
  clearEvents(): void {
    this._events = [];
  }

  /** Применить доменное событие к агрегату */
  applyEvent(event: DomainEvent): void {
    // Проверяем, что событие относится к этому агрегату
    const expectedId = this.getAggregateIdValue();
    if (event.aggregateId !== expectedId) {
      throw new Error(
        `Event does not belong to this aggregate. Expected ID: ${expectedId}, received: ${event.aggregateId}`
      );
    }

    // Проверяем версию (для предотвращения гонок)
    if (event.aggregateVersion !== this._version) {
      throw new Error(`Invalid aggregate version. Expected: ${this._version}, received: ${event.aggregateVersion}`);
    }

    // Применяем событие через protected метод (должен быть реализован в наследниках)
    this.when(event);
    
    // Увеличиваем версию агрегата
    this._version++;

    // Обновляем свойства агрегата
    this.updateProps(event.payload);
  }

  /** Создать доменное событие */
  protected createEvent(type: string, payload: Record<string, unknown>): DomainEvent {
    return {
      eventId: this.generateEventId(),
      type,
      timestamp: new Date(),
      aggregateId: this.getAggregateIdValue(),
      aggregateVersion: this._version,
      correlationId: this.generateCorrelationId(),
      payload,
    };
  }

  /** Добавить событие в очередь некоммитченных событий */
  protected addEvent(event: DomainEvent): void {
    this._events.push(event);
  }

  /** Генерировать уникальный ID для события */
  private generateEventId(): string {
    const aggregateId = this.getAggregateIdValue();
    const random = IdGenerator.generateRandomString(9);
    return `evt_${aggregateId}_${Date.now()}_${random}`;
  }

  /** Сгенерировать correlation ID */
  private generateCorrelationId(): string {
    return CorrelationIdProvider.generate('corr');
  }

  /** 
   * Protected метод для применения события (должен быть реализован в наследниках)
   * Используется паттерн Visitor для обработки различных типов событий
   */
  protected abstract when(event: DomainEvent): void;

  /**
   * Обновить свойства агрегата на основе события
   * Наследники должны переопределить для безопасного immutable update
   * 
   * По умолчанию ничего не делает - наследники обновляют состояние через setProps() в when* методах
   */
  protected updateProps(payload: Record<string, unknown>): void {
    // Эта реализация предназначена для наследников
    // Наследники должны обновлять состояние в when* методах через setProps()
  }

  /** Сравнить два агрегата на равенство */
  equals(other: AggregateRoot<TProps>): boolean {
    return this.id.equals(other.id);
  }

  /** Получить строковое представление агрегата */
  toString(): string {
    return `${this.constructor.name}(id=${this.id.toString()}, version=${this._version})`;
  }

  /** Сериализовать агрегат для сохранения */
  abstract serialize(): Record<string, unknown>;
}

/**
 * Утилиты для работы с AggregateRoot
 */
/* istanbul ignore next -- TS namespace merge emits unreachable || branch */
export namespace AggregateRoot {
  /** Создать пустой агрегат-заглушку для тестирования */
  export function createTestAggregate(id?: string): TestAggregate {
    return new TestAggregate(
      id ? EntityId.fromString(id) : EntityId.random()
    );
  }
}

/**
 * Тестовый агрегат для примеров и тестирования
 */
class TestAggregate extends AggregateRoot {
  constructor(id: EntityId) {
    super(id, { created: true });
  }

  protected when(event: DomainEvent): void {
    // Тестовый агрегат - просто принимает события без изменений
    // Используется для тестирования базовой функциональности AggregateRoot
  }

  serialize(): Record<string, unknown> {
    return {
      id: this.id.toString(),
      version: this._version,
      props: { ...this.props },
    };
  }
}