import { createHmac, timingSafeEqual } from 'crypto';
import type * as core from 'express-serve-static-core';
import { readStr } from '../../core/config/app-config';

/**
 * Slack request signature verification middleware (S-03 remediation).
 *
 * Validates the `x-slack-signature` header using HMAC-SHA256 with the
 * configured `SLACK_SIGNING_SECRET`. Rejects spoofed/replayed requests.
 *
 * Slack signing spec: https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * @see KNOWN_BUGS.md SEC-SLACK-001
 */

const MAX_TIMESTAMP_AGE_SECONDS = 300; // 5 minutes — Slack recommendation

interface RequestWithRawBody extends core.Request {
  rawBody?: Buffer;
}

export function createSlackSignatureMiddleware(): (
  req: core.Request,
  res: core.Response,
  next: core.NextFunction,
) => void {
  return (req: core.Request, res: core.Response, next: core.NextFunction): void => {
    const signingSecret = readStr('SLACK_SIGNING_SECRET', '');

    // If no signing secret configured, reject all requests (fail-closed)
    if (!signingSecret) {
      res.status(503).json({
        ok: false,
        error: 'slack_signing_not_configured',
      });
      return;
    }

    const signature = req.headers['x-slack-signature'] as string | undefined;
    const timestampStr = req.headers['x-slack-request-timestamp'] as string | undefined;

    if (!signature || !timestampStr) {
      res.status(401).json({
        ok: false,
        error: 'missing_slack_signature',
      });
      return;
    }

    // Replay attack prevention: reject stale timestamps
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      res.status(401).json({
        ok: false,
        error: 'invalid_slack_timestamp',
      });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > MAX_TIMESTAMP_AGE_SECONDS) {
      res.status(403).json({
        ok: false,
        error: 'slack_request_expired',
      });
      return;
    }

    // Compute expected signature: v0=HMAC-SHA256(secret, "v0:{timestamp}:{rawBody}")
    const rawBody = (req as RequestWithRawBody).rawBody;
    if (!rawBody) {
      res.status(500).json({
        ok: false,
        error: 'raw_body_not_available',
      });
      return;
    }

    const baseString = `v0:${timestampStr}:${rawBody.toString('utf8')}`;
    const expectedSignature = 'v0=' + createHmac('sha256', signingSecret)
      .update(baseString)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    const expected = Buffer.from(expectedSignature, 'utf8');
    const provided = Buffer.from(signature, 'utf8');

    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      res.status(401).json({
        ok: false,
        error: 'invalid_slack_signature',
      });
      return;
    }

    next();
  };
}
