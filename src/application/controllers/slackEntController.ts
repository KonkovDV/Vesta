import type { Request, Response } from 'express-serve-static-core';
import { SlackSlashCommandUseCase } from '../integrations/slack/slack-slash-command.usecase';
import type { ILogger } from '../../core/decorators/ILogger';
import { SlackSlashRequestSchema } from '../validators/api-schemas';

interface SlackSlashPayload {
  team_id?: string;
  teamId?: string;
  channel_id?: string;
  channelId?: string;
  user_id?: string;
  userId?: string;
  text?: string;
  thread_ts?: string;
  threadTs?: string;
}

interface SlackRequestWithBody extends Request {
  body: Partial<SlackSlashPayload> | Record<string, unknown>;
}

/**
 * HTTP-контроллер для enterprise Slack-интеграции.
 * Минимальный echo endpoint для slash-команды.
 */
export class SlackEntController {
  constructor(
    private readonly slackSlashCommandUseCase: SlackSlashCommandUseCase,
    private readonly logger?: ILogger,
  ) {}

  /**
   * POST /ent/slack/slash
   *
   * Ожидает JSON-пейлоад в slack-стиле:
   * { team_id, channel_id, user_id, text, thread_ts? }.
   */
  async handleSlash(req: Request, res: Response): Promise<void> {
    try {
      const rawBody = (req as SlackRequestWithBody).body;
      const parseResult = SlackSlashRequestSchema.safeParse(rawBody ?? {});
      
      if (!parseResult.success) {
        res.status(400).json({
          ok: false,
          error: 'invalid_slash_payload',
          details: parseResult.error.flatten(),
        });
        return;
      }

      const validated = parseResult.data;

      const teamId = String(validated.team_id ?? validated.teamId ?? '');
      const channelId = String(validated.channel_id ?? validated.channelId ?? '');
      const userId = String(validated.user_id ?? validated.userId ?? '');
      const text = validated.text ?? '';
      const rawThreadTs = validated.thread_ts ?? validated.threadTs;
      const threadTs =
        typeof rawThreadTs === 'string' && rawThreadTs.trim().length > 0
          ? rawThreadTs
          : undefined;

      if (!teamId || !channelId || !userId) {
        res.status(400).json({
          ok: false,
          error: 'invalid_slash_payload',
          missing: {
            teamId: !teamId,
            channelId: !channelId,
            userId: !userId,
          },
        });
        return;
      }

      await this.slackSlashCommandUseCase.execute({
        teamId,
        channelId,
        userId,
        text,
        threadTs,
      });

      res.status(200).json({ ok: true });
    } catch (error) {
      if (this.logger) {
        this.logger.error('[SlackEntController] /ent/slack/slash failed', {
          error:
            error instanceof Error
              ? { message: error.message, stack: error.stack }
              : { message: String(error) },
        });
      }
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  }
}