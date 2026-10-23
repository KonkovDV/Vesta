/**
 * Ingestion Controller — handles multimodal content ingestion.
 * 
 * Endpoints:
 * - POST /api/v1/memory/ingest/pdf
 * - POST /api/v1/memory/ingest/image
 * - POST /api/v1/memory/ingest/text
 * - POST /api/v1/memory/ingest/url
 * 
 * Layer: Presentation/HTTP
 */

import type { Request, Response } from 'express-serve-static-core';
import type { 
  IContentIngestionService,
  IngestContentResult,
  IngestedFact,
  IngestPDFInput,
  IngestImageInput,
  IngestTextInput,
  IngestURLInput,
} from '../../../../domain/memory/content-ingestion';
import {
  requestContextTenantId,
  resolveScopedTenant,
  type AuthenticatedRequest,
} from '../../../../application/middleware/auth';

interface IngestResponse {
  success: boolean;
  facts: IngestedFact[];
  chunksProcessed: number;
  processingTimeMs: number;
  warnings?: string[];
  stored: number;
  duplicates: number;
  rejected: Array<{ reason: string; count: number }>;
}

export class IngestionController {
  constructor(
    private readonly ingestionService: IContentIngestionService
  ) {}

  private scopedIdentity(req: Request, res: Response, missingMessage: string): { tenantId: string; userId: string } | undefined {
    const bodyTenantId = typeof req.body?.tenantId === 'string' && req.body.tenantId.trim().length > 0
      ? req.body.tenantId.trim()
      : undefined;
    const bodyUserId = typeof req.body?.userId === 'string' && req.body.userId.trim().length > 0
      ? req.body.userId.trim()
      : undefined;
    const scope = resolveScopedTenant(req, bodyTenantId, requestContextTenantId);
    if (!scope.allowed) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'tenantId does not match the authenticated tenant' },
      });
      return undefined;
    }
    const authUserId = (req as AuthenticatedRequest).authContext?.userId;
    if (authUserId && bodyUserId && bodyUserId !== authUserId) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'userId does not match the authenticated user' },
      });
      return undefined;
    }
    const userId = typeof authUserId === 'string' && authUserId.length > 0 ? authUserId : bodyUserId;
    if (!scope.tenantId || !userId) {
      res.status(400).json({ error: missingMessage });
      return undefined;
    }
    return { tenantId: scope.tenantId, userId };
  }

  private confirmed(req: Request): boolean {
    return req.body?.confirmed === true;
  }

  private ok(res: Response, result: IngestContentResult): void {
    const response: IngestResponse = {
      success: true,
      facts: result.facts,
      chunksProcessed: result.chunksProcessed,
      processingTimeMs: result.processingTimeMs,
      warnings: result.warnings,
      stored: result.stored ?? 0,
      duplicates: result.duplicates ?? 0,
      rejected: result.rejected ?? [],
    };
    res.status(200).json(response);
  }

  /**
   * POST /api/v1/memory/ingest/pdf
   * Body: { tenantId, userId, source, isBase64?, extractionPrompt? }
   */
  async ingestPdf(req: Request, res: Response): Promise<void> {
    try {
      const identity = this.scopedIdentity(req, res, 'tenantId, userId, and source are required');
      if (!identity) return;
      const { source, isBase64 = false, extractionPrompt } = req.body;
      if (!source) {
        res.status(400).json({ error: 'tenantId, userId, and source are required' });
        return;
      }
      const { tenantId, userId } = identity;

      const input: IngestPDFInput = {
        tenantId,
        userId,
        contentType: 'pdf',
        source,
        isBase64,
        extractionPrompt,
        confirmed: this.confirmed(req),
      };

      this.ok(res, await this.ingestionService.ingestPDF(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * POST /api/v1/memory/ingest/image
   * Body: { tenantId, userId, imageBase64, mimeType?, analysisPrompt? }
   */
  async ingestImage(req: Request, res: Response): Promise<void> {
    try {
      const identity = this.scopedIdentity(req, res, 'tenantId, userId, and imageBase64 are required');
      if (!identity) return;
      const { imageBase64, mimeType, analysisPrompt } = req.body;
      if (!imageBase64) {
        res.status(400).json({ error: 'tenantId, userId, and imageBase64 are required' });
        return;
      }
      const { tenantId, userId } = identity;

      const input: IngestImageInput = {
        tenantId,
        userId,
        contentType: 'image',
        imageBase64,
        mimeType,
        analysisPrompt,
        confirmed: this.confirmed(req),
      };

      this.ok(res, await this.ingestionService.ingestImage(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * POST /api/v1/memory/ingest/text
   * Body: { tenantId, userId, text }
   */
  async ingestText(req: Request, res: Response): Promise<void> {
    try {
      const identity = this.scopedIdentity(req, res, 'tenantId, userId, and text are required');
      if (!identity) return;
      const { text } = req.body;
      if (!text) {
        res.status(400).json({ error: 'tenantId, userId, and text are required' });
        return;
      }
      const { tenantId, userId } = identity;

      const input: IngestTextInput = {
        tenantId,
        userId,
        contentType: 'text',
        text,
        confirmed: this.confirmed(req),
      };

      this.ok(res, await this.ingestionService.ingestText(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * POST /api/v1/memory/ingest/url
   * Body: { tenantId, userId, url }
   */
  async ingestUrl(req: Request, res: Response): Promise<void> {
    try {
      const identity = this.scopedIdentity(req, res, 'tenantId, userId, and url are required');
      if (!identity) return;
      const { url } = req.body;
      if (!url) {
        res.status(400).json({ error: 'tenantId, userId, and url are required' });
        return;
      }
      const { tenantId, userId } = identity;

      const input: IngestURLInput = {
        tenantId,
        userId,
        contentType: 'url',
        url,
        confirmed: this.confirmed(req),
      };

      this.ok(res, await this.ingestionService.ingestURL(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * GET /api/v1/memory/ingest/types
   * Returns supported ingestion types.
   */
  async getSupportedTypes(req: Request, res: Response): Promise<void> {
    try {
      const types = this.ingestionService.getSupportedTypes();
      res.status(200).json({ types });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }
}
