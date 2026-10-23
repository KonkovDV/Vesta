/**
 * IAppFactory
 * Layer: Core (contracts)
 *
 * Нейтральный контракт фабрики HTTP-приложения.
 * Реализация находится в application-слое и регистрируется в DI под токеном 'AppFactory'.
 * Core использует только этот интерфейс и DI-токен, не зная деталей Express/HTTP.
 */

export interface IAppFactory {
  createApp(): Promise<{ app: unknown }>;
}