import type { CircuitBreakerEvent } from './CircuitBreakerEvents';

export interface ICircuitBreakerEventObserver {
  /**
   * Hook для наблюдения за жизненным циклом Circuit Breaker.
   * Ошибки реализации observer’а не должны "пробивать" Circuit Breaker.
   */
  onEvent(event: CircuitBreakerEvent): void;
}

export class NoopCircuitBreakerEventObserver
  implements ICircuitBreakerEventObserver
{
  // Намеренно ничего не делает; используется по умолчанию.
  // onEvent остаётся синхронным, чтобы не влиять на выполнение операций.
   
  onEvent(_event: CircuitBreakerEvent): void {
    // no-op
  }
}