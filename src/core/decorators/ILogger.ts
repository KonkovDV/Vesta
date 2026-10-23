/**
 * ILogger - абстракция для логирования
 * Layer: Core
 * 
 * Предоставляет интерфейс для логирования, не зависящий от конкретной реализации.
 * Позволяет использовать разные логгеры (console, winston, pino) без изменения кода.
 */

export interface ILogger {
  /**
   * Логировать информационное сообщение
   * @param message - Сообщение
   * @param meta - Дополнительные метаданные
   */
  log(message: string, meta?: Record<string, unknown>): void;
  
  /**
   * Логировать ошибку
   * @param message - Сообщение об ошибке
   * @param meta - Дополнительные метаданные
   */
  error(message: string, meta?: Record<string, unknown>): void;
  
  /**
   * Логировать предупреждение
   * @param message - Предупреждающее сообщение
   * @param meta - Дополнительные метаданные
   */
  warn(message: string, meta?: Record<string, unknown>): void;
  
  /**
   * Логировать отладочную информацию
   * @param message - Отладочное сообщение
   * @param meta - Дополнительные метаданные
   */
  debug(message: string, meta?: Record<string, unknown>): void;
  
  /**
   * @param message - Сообщение
   * @param meta - Дополнительные метаданные
   */
  info(message: string, meta?: Record<string, unknown>): void;
}