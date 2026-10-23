import {
  ChatService,
  type DomainChatCompletionRequest,
  type DomainChatCompletionResult,
} from '../../domain/services/ChatService';

type ChatTurn = { role: string; content: string };

function turnsFrom(request: DomainChatCompletionRequest): ChatTurn[] {
  const raw = (request as { messages?: unknown }).messages;
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return [];
      }
      const role = 'role' in item && typeof item.role === 'string' ? item.role : 'user';
      const content = 'content' in item && typeof item.content === 'string' ? item.content : '';
      return content.trim().length > 0 ? [{ role, content }] : [];
    });
  }
  if (typeof request.message === 'string' && request.message.trim().length > 0) {
    return [{ role: 'user', content: request.message }];
  }
  return [];
}

/**
 * Chat runtime that asks a loopback model started in this session.
 * No external provider key is used.
 */
export class SelfChatService extends ChatService {
  constructor(private readonly baseUrl: string) {
    super();
  }

  override async generateChatCompletion(
    request: DomainChatCompletionRequest,
    conversationId: string | undefined,
    userId: string,
  ): Promise<DomainChatCompletionResult> {
    const content = await this.complete(request, conversationId, userId);
    return {
      model: 'session-self',
      content,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  override async streamChatCompletion(
    request: DomainChatCompletionRequest,
    conversationId: string | undefined,
    userId: string,
    handlers: Parameters<ChatService['streamChatCompletion']>[3],
  ): Promise<void> {
    try {
      const content = await this.complete(request, conversationId, userId);
      handlers.onChunk(content);
      handlers.onComplete(content, undefined, {
        prompt_n: 0,
        predicted_n: 1,
        predicted_ms: 1,
        cache_n: 0,
      });
    } catch (error) {
      handlers.onError(error instanceof Error ? error : new Error('Unknown streaming error'));
    }
  }

  private async complete(
    request: DomainChatCompletionRequest,
    conversationId: string | undefined,
    userId: string,
  ): Promise<string> {
    const response = await fetch(new URL('/v1/chat/completions', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'session-self',
        messages: turnsFrom(request),
        conversationId,
        userId,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new Error(`Session model returned ${response.status}`);
    }
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content?.trim() ?? '';
    if (content.length === 0) {
      throw new Error('Session model returned an empty reply');
    }
    return content;
  }
}
