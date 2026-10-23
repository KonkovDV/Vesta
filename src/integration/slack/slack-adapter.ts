import type {
  IntegrationAdapter,
  IntegrationHealth,
  IntegrationType,
} from '../integration-adapter.interface';

export interface SlackNotificationClient {
  sendMessage(text: string): Promise<void>;
}

/**
 * Slack‑адаптер для ENT Integration Hub, использующий SlackNotificationClient.
 *
 * В рамках Step1 health/isAvailable остаются стабовыми (без сетевых health‑пингов),
 * а фактическая отправка сообщений выполняется через sendNotification().
 */
export class SlackIntegrationAdapter implements IntegrationAdapter {
  private readonly id = 'slack-default';
  private readonly type: IntegrationType = 'slack';

  constructor(private readonly notificationClient: SlackNotificationClient) {}

  getId(): string {
    return this.id;
  }

  getType(): IntegrationType {
    return this.type;
  }

  async isAvailable(): Promise<boolean> {
    // Step1: стабовая реализация, всегда доступна, без внешних health‑пингов.
    return true;
  }

  async healthCheck(): Promise<IntegrationHealth> {
    return {
      id: this.id,
      type: this.type,
      status: 'healthy',
      message:
        'Slack adapter for ENT Integration Hub (webhook connector; health is stub, no external call)',
      checkedAt: new Date().toISOString(),
      details: {
        mode: 'webhook-connector',
      },
    };
  }

  /**
   * Внутренний API для ENT‑слоя: минимальная нотификация в Slack‑канал.
   */
  async sendNotification(message: string): Promise<void> {
    await this.notificationClient.sendMessage(message);
  }
}