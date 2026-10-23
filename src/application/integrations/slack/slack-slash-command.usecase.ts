import { RequestContext } from '../../context/request-context';
import type {
  SlackIncomingMessage,
  SlackIntegrationPort,
} from '../../../domain/integrations/slack/slack-port';
import type {
  ChatService,
  DomainChatCompletionRequest,
} from '../../../domain/services/ChatService';

export interface SlackSlashCommandInput {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  threadTs?: string;
}

/**
 * Application use-case для обработки Slack slash-команды.
 * LLM-first флоу: сначала пытаемся получить ответ от чат-сервиса, при ошибке — fallback‑echo.
 */
export class SlackSlashCommandUseCase {
  constructor(
    private readonly slackPort: SlackIntegrationPort,
    private readonly chatService: ChatService,
  ) {}

  async execute(input: SlackSlashCommandInput): Promise<void> {
    const correlationId = this.tryGetCorrelationId();

    const incoming: SlackIncomingMessage = {
      teamId: input.teamId,
      channelId: input.channelId,
      userId: input.userId,
      text: input.text,
      threadTs: input.threadTs,
      metadata: correlationId
        ? {
            correlationId,
          }
        : undefined,
    };

    try {
      const llmText = await this.generateLlmResponse(input);
      const finalText =
        this.normalizeLlmText(llmText) || this.buildFallbackText(input.text);

      await this.slackPort.replyTo(incoming, finalText);
    } catch {
      // TODO: интегрировать структурное логирование/мониторинг ошибок LLM в ENT Slack-флоу.
      const fallbackText = this.buildFallbackText(input.text);
      await this.slackPort.replyTo(incoming, fallbackText);
    }
  }

  private tryGetCorrelationId(): string | undefined {
    try {
      return RequestContext.getCorrelationId();
    } catch {
      return undefined;
    }
  }

  private async generateLlmResponse(
    input: SlackSlashCommandInput,
  ): Promise<string> {
    const trimmed = this.normalizeInputText(input.text);

    const request: DomainChatCompletionRequest = {
      // Совместимая с BFF форма: один user‑message с текстом без картинок.
      messages: [
        {
          role: 'user',
          content: trimmed,
        },
      ],
    };

    const result = await this.chatService.generateChatCompletion(
      request,
      undefined,
      input.userId,
    );

    return typeof result?.content === 'string' ? result.content : '';
  }

  private normalizeInputText(text: string): string {
    return typeof text === 'string' ? text.trim() : '';
  }

  private normalizeLlmText(text: string | undefined | null): string {
    return typeof text === 'string' ? text : '';
  }

  private buildFallbackText(text: string): string {
    const trimmed = this.normalizeInputText(text);
    return `MicroPhoenix (fallback): ${trimmed}`;
  }
}