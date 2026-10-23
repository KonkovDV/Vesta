/**
 * Shared types for infrastructure bootstrap configuration.
 * Separated to avoid circular dependencies between bootstrap modules.
 */
export type BootstrapEnvironment = 'production' | 'development' | 'test';

export interface BootstrapConfig {
  initTimeoutMs?: number;
  logInitialization?: boolean;
  /**
   * Logical environment profile.
   * Controls strict invariants (e.g. mandatory Outbox and DI validation).
   */
  environment?: BootstrapEnvironment;
  useInMemoryRepositories?: boolean;
  quiet?: boolean;
}

export interface IGracefulShutdownManager {
  registerHandler(name: string, handler: () => Promise<void>): void;
}