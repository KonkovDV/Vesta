/**
 * IHttpServer
 * Layer: Core (contracts)
 *
 * Инфраструктурный HTTP сервер, инкапсулирующий запуск/остановку Express (или
 * другого web-фреймворка). Реализация располагается в infrastructure-слое и
 * регистрируется в DI под токеном 'HttpServer'. Core-слой оперирует только
 * контрактом/токеном, не зная деталей Express.
 */
export interface HttpServerStartOptions {
  /** Порт, на котором необходимо запустить HTTP сервер. */
  port: number;
  /** Необязательный host, например '0.0.0.0'. */
  host?: string;
  /** Управляет логированием факта старта сервера. */
  logStart?: boolean;
}

export interface HttpServerStartResult {
  /** Итоговый порт (может отличаться, если использовался 0). */
  port: number;
  /** Экземпляр HTTP приложения (Express) для обслуживания запросов. */
  app: unknown;
}

export interface IHttpServer {
  /**
   * Запускает сервер и возвращает фактический порт и HTTP-приложение.
   * Повторный запуск без предыдущей остановки должен завершаться ошибкой.
   */
  start(options: HttpServerStartOptions): Promise<HttpServerStartResult>;

  /** Останавливает сервер. Повторные вызовы idempotent. */
  stop(): Promise<void>;

  /** Возвращает true, если сервер уже запущен. */
  isRunning(): boolean;
}
