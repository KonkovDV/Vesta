import type {
  SlackIncomingMessage,
  SlackIntegrationPort,
  SlackOutgoingMessage,
  SlackMessageVisibility,
} from '../../../domain/integrations/slack/slack-port';
import { getConfig } from '../../../config';

export interface SlackHttpAdapterOptions {
  botToken: string;
  apiBaseUrl?: string;
  fetchFn?: (url: string, init?: unknown) => Promise<SlackHttpResponse>;
}

export interface SlackHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

/**
 * Реализация SlackIntegrationPort поверх Slack Web API (chat.postMessage).
 */
export class SlackHttpAdapter implements SlackIntegrationPort {
  private readonly botToken: string;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: (url: string, init?: unknown) => Promise<SlackHttpResponse>;
  private readonly debug: boolean;

  constructor(options: SlackHttpAdapterOptions) {
    this.botToken = options.botToken;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://slack.com/api').replace(/\/$/, '');

    const configuredFetch = options.fetchFn;
    const globalFetch = (globalThis as { fetch?: (url: string, init?: unknown) => Promise<SlackHttpResponse> }).fetch;

    const fetchFn = configuredFetch ?? globalFetch;

    if (typeof fetchFn !== 'function') {
      throw new Error('[SlackHttpAdapter] fetch function is not available (global fetch or custom fetchFn)');
    }

    this.fetchFn = fetchFn;
    const appConfig = getConfig();
    this.debug = appConfig.SLACK_DEBUG === 'true';

    if (!this.botToken) {
      throw new Error('[SlackHttpAdapter] botToken is required');
    }
  }

  async sendMessage(message: SlackOutgoingMessage): Promise<void> {
    const endpoint = `${this.apiBaseUrl}/chat.postMessage`;

    const payload: Record<string, unknown> = {
      channel: message.channelId,
      text: message.text,
      mrkdwn: true,
    };

    if (message.threadTs) {
      payload.thread_ts = message.threadTs;
    }

    const visibility: SlackMessageVisibility | undefined = message.visibility;
    if (visibility === 'in_channel' && message.threadTs) {
      // Для ответов в треде Slack ожидает broadcast‑флаг, чтобы показать сообщение в канале.
      payload.reply_broadcast = true;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${this.botToken}`,
    };

    const correlationId = message.metadata?.correlationId;
    if (typeof correlationId === 'string' && correlationId.length > 0) {
      headers['X-Correlation-Id'] = correlationId;
    }

    if (this.debug) {
       
      console.debug('[SlackHttpAdapter] sendMessage', {
        channelId: message.channelId,
        hasThread: Boolean(message.threadTs),
        visibility: message.visibility,
      });
    }

    const response = await this.fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    await this.handleSlackResponse(response, 'chat.postMessage');
  }

  async replyTo(message: SlackIncomingMessage, text: string): Promise<void> {
    const threadTs = message.threadTs ?? message.metadata?.threadTs;

    const outgoing: SlackOutgoingMessage = {
      teamId: message.teamId,
      channelId: message.channelId,
      threadTs: typeof threadTs === 'string' ? threadTs : undefined,
      text,
      visibility: 'in_channel',
      metadata: message.metadata,
    };

    await this.sendMessage(outgoing);
  }

  private async handleSlackResponse(response: SlackHttpResponse, method: string): Promise<void> {
    if (!response) {
      throw new Error(`[SlackHttpAdapter] Empty response from Slack for ${method}`);
    }

    if (!response.ok) {
      let body: string | undefined;
      try {
        body = await response.text();
      } catch {
        body = undefined;
      }

      throw new Error(
        `[SlackHttpAdapter] HTTP error calling ${method}: ${response.status} ${response.statusText}` +
          (body ? ` – ${body}` : ''),
      );
    }

    let parsed: { ok?: boolean; error?: string };
    try {
      parsed = (await response.json()) as { ok?: boolean; error?: string };
    } catch {
      throw new Error(`[SlackHttpAdapter] Unable to parse Slack ${method} response as JSON`);
    }

    if (!parsed || parsed.ok !== true) {
      const errorCode = parsed?.error ?? 'unknown_error';
      throw new Error(`[SlackHttpAdapter] Slack ${method} returned error: ${errorCode}`);
    }
  }
}

class DisabledSlackIntegrationPort implements SlackIntegrationPort {
  async sendMessage(_message: SlackOutgoingMessage): Promise<void> {
    throw new Error(
      '[SlackIntegrationPort] Slack integration is disabled or not configured (SLACK_BOT_TOKEN is missing)',
    );
  }

  async replyTo(_message: SlackIncomingMessage, _text: string): Promise<void> {
    throw new Error(
      '[SlackIntegrationPort] Slack integration is disabled or not configured (SLACK_BOT_TOKEN is missing)',
    );
  }
}

/**
 * Фабрика адаптера Slack из ENV‑конфигурации.
 *
 * - SLACK_BOT_TOKEN — обязательный токен бота;
 * - SLACK_API_BASE — опциональный override базового URL (по умолчанию https://slack.com/api).
 */
export function createSlackHttpAdapterFromEnv(): SlackHttpAdapter {
  const config = getConfig();
  const botToken = config.SLACK_BOT_TOKEN;
  const apiBaseUrl = config.SLACK_API_BASE;

  if (!botToken || botToken.length === 0) {
    throw new Error(
      '[SlackHttpAdapter] SLACK_BOT_TOKEN is not set; Slack integration is not configured',
    );
  }

  return new SlackHttpAdapter({
    botToken,
    apiBaseUrl,
  });
}

/**
 * Создаёт "выключенную" реализацию SlackIntegrationPort, которая явно сигнализирует
 * об отсутствии конфигурации при любом вызове.
 */
export function createDisabledSlackIntegrationPort(): SlackIntegrationPort {
  return new DisabledSlackIntegrationPort();
}