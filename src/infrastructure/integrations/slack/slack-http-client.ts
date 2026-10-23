export interface SlackHttpClientOptions {
  webhookUrl?: string;
  fetchFn?: (url: string, init?: unknown) => Promise<SlackHttpResponse>;
}

export interface SlackHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json?: () => Promise<unknown>;
  text: () => Promise<string>;
}

/**
 * Минимальный HTTP‑клиент для отправки сообщений в Slack incoming webhook.
 *
 * Не выполняет дополнительных health‑проверок и не логирует чувствительные данные.
 */
export class SlackHttpClient {
  private readonly webhookUrl?: string;
  private readonly fetchFn: (url: string, init?: unknown) => Promise<SlackHttpResponse>;

  constructor(options: SlackHttpClientOptions) {
    this.webhookUrl = options.webhookUrl;

    const configuredFetch = options.fetchFn;
    const globalFetch = (globalThis as { fetch?: (url: string, init?: unknown) => Promise<SlackHttpResponse> }).fetch;

    const fetchFn = configuredFetch ?? globalFetch;

    if (typeof fetchFn !== 'function') {
      throw new Error(
        '[SlackHttpClient] fetch function is not available (global fetch or custom fetchFn)',
      );
    }

    this.fetchFn = fetchFn;
  }

  /**
   * Возвращает true, если webhook URL сконфигурирован (не пустая строка).
   */
  isConfigured(): boolean {
    return typeof this.webhookUrl === 'string' && this.webhookUrl.length > 0;
  }

  /**
   * Отправляет простое текстовое сообщение в Slack‑webhook.
   *
   * При отсутствии конфигурации SLACK_WEBHOOK_URL кидает контролируемую ошибку.
   */
  async sendMessage(text: string): Promise<void> {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) {
      throw new Error('[SlackHttpClient] text must be a non-empty string');
    }

    if (!this.isConfigured()) {
      throw new Error(
        '[SlackHttpClient] SLACK_WEBHOOK_URL is not configured; Slack webhook notifications are disabled',
      );
    }

    const endpoint = this.webhookUrl as string;

    const response = await this.fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ text: normalized }),
    });

    if (!response) {
      throw new Error('[SlackHttpClient] Empty response from Slack webhook');
    }

    if (!response.ok) {
      let body: string | undefined;
      try {
        body = await response.text();
      } catch {
        body = undefined;
      }

      const errorMessage =
        `[SlackHttpClient] Slack webhook returned HTTP ${response.status} ${response.statusText}` +
        (body ? ` – ${body}` : '');

      throw new Error(errorMessage);
    }
  }
}