export type SlackMessageVisibility = 'in_channel' | 'ephemeral';

export interface SlackMessageMetadata {
  /** Корреляционный идентификатор из RequestContext. */
  correlationId?: string;
  /** Дополнительные диагностические поля. */
  [key: string]: unknown;
}

export interface SlackIncomingMessage {
  /** Workspace Slack. */
  teamId: string;
  /** Канал, где получено сообщение. */
  channelId: string;
  /** Пользователь-инициатор. */
  userId: string;
  /** Идентификатор треда, если сообщение в цепочке. */
  threadTs?: string;
  /** Текст пользовательского запроса. */
  text: string;
  /** Сырые данные Slack payload после маппинга протокола. */
  rawPayload?: Record<string, unknown>;
  /** Метаданные трассировки/аудита. */
  metadata?: SlackMessageMetadata;
}

export interface SlackOutgoingMessage {
  /** Workspace Slack. */
  teamId: string;
  /** Канал назначения. */
  channelId: string;
  /** Тред, куда должен уйти ответ. */
  threadTs?: string;
  /** Текст ответа MicroPhoenix. */
  text: string;
  /** Режим видимости ответа для Slack. */
  visibility?: SlackMessageVisibility;
  /** Метаданные трассировки/аудита. */
  metadata?: SlackMessageMetadata;
}

/**
 * Доменный порт отправки сообщений в Slack.
 */
export interface SlackIntegrationPort {
  /** Отправка сообщения в Slack без привязки к исходному запросу. */
  sendMessage(message: SlackOutgoingMessage): Promise<void>;
  /**
   * Ответ на входящее сообщение в том же канале/треде.
   * Упрощённый helper поверх sendMessage.
   */
  replyTo(message: SlackIncomingMessage, text: string): Promise<void>;
}