/**
 * Bootstrap validation helpers extracted from bootstrap.ts.
 */
import { container, DIContainer, ServiceTokens } from '../../../core/di/container';
import type { IOutbox } from '../../../domain/events/outbox.interface';

export function validateBootstrapContainer(environment: string, logInitialization: boolean): void {
  const baseRequired: Array<string | symbol> = ['ILogger', 'IDatabaseConnection', 'IMetricsPort', 'IAIClient'];

  const infraProductionRequired: Array<string | symbol> = [
    'IEventStore',
    'IEventBus',
    'IOutbox',
    'LLMAdapterFactory',
    'PolicyEngine',
  ];

  const appProductionRequired: Array<string | symbol> = [
    'ChatService',
    'ConversationService',
    'FileProcessingService',
    'FeatureFlagsService',
    'HealthCheckService',
    'AuthService',
    'IAuthService',
    'RateLimitService',
    'EventStoreService',
    'EventBusService',
    'CreateConversationUseCase',
    'GetConversationUseCase',
    'AddParticipantUseCase',
    'ArchiveConversationUseCase',
    'SendMessageUseCase',
    'UpdateConversationUseCase',
    'ListConversationsUseCase',
    'DeleteConversationUseCase',
    'ExportConversationsUseCase',
    'ImportConversationsUseCase',
    'UploadFileUseCase',
  ];

  const requiredTokens =
    environment === 'production'
      ? [...baseRequired, ...infraProductionRequired, ...appProductionRequired]
      : baseRequired;

  const missing = requiredTokens.filter((token) => !container.isRegistered(token));
  if (missing.length > 0) {
    const message = `[Bootstrap][${environment === 'production' ? 'FATAL' : 'WARN'}] Missing required DI services for environment=${environment}: ${missing.join(', ')}`;
    if (environment === 'production') {
      throw new Error(message);
    }
    if (logInitialization) {
      console.warn(message);
    }
  }

  if (environment === 'production' && container.isRegistered('IOutbox')) {
    const outbox = container.resolve<IOutbox>('IOutbox');
    const name = String(outbox?.constructor?.name || '').toLowerCase();
    const isNullLike =
      typeof outbox?.saveEventsWithOutbox === 'function' &&
      (name.includes('null') || name.includes('stub'));
    if (isNullLike) {
      throw new Error('[Bootstrap][FATAL] NullOutbox-like implementation detected for IOutbox in production. Configure a real Outbox implementation.');
    }
  }
}

export function validateContainer(c: DIContainer): void {
  const required = [
    ServiceTokens.DatabaseConnection,
    ServiceTokens.IConversationRepository,
    ServiceTokens.IEventBus,
    ServiceTokens.OpenAIClient,
  ];
  const missing = required.filter((t) => !c.isRegistered(t));
  if (missing.length > 0) {
    throw new Error('Missing required services: ' + missing.join(', '));
  }
}
