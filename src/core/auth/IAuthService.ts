/**
 * Core-level authentication contracts.
 *
 * Реализации находятся в верхних слоях (application/infrastructure)
 * и предоставляются через DI. Core/AOP зависят только от этих интерфейсов.
 */

export interface AuthContext {
  readonly userId: string;
  readonly scopes: string[];
  readonly [key: string]: unknown;
}

export interface IAuthService {
  /**
   * Аутентификация по произвольному токену (header, bearer, api-key и т.п.).
   * Должна вернуть AuthContext либо выбросить ошибку.
   */
  authenticate(token: string): Promise<AuthContext>;

  /**
   * Создание доменного/HTTP-совместимого исключения при ошибке авторизации.
   * Опционально, чтобы не привязывать core к конкретному transport-слою.
   */
  authError?(message: string, statusCode?: number): Error;

  /**
   * Проверка наличия требуемых scope-ов; при нарушении должна бросать ошибку.
   */
  ensureScope(auth: AuthContext, required: string | string[]): void;
}