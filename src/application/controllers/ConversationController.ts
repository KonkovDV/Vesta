import express from 'express';
import * as core from 'express-serve-static-core';
import { z } from 'zod';
import { AuthService } from '../services/AuthService';
import { RateLimitService } from '../services/RateLimitService';
import {
  ProtocolUtils,
  ProtocolErrorCode,
} from '../../protocol/index';
import {
  CreateConversationUseCase,
  GetConversationUseCase,
  UpdateConversationUseCase,
  ArchiveConversationUseCase,
  ListConversationsUseCase,
  DeleteConversationUseCase,
  ExportConversationsUseCase,
  ImportConversationsUseCase,
  UploadFileUseCase,
} from '../usecases/conversations';
import type { DomainFileUploadInput } from '../../domain/services/FileProcessingService';
import { BaseController } from './BaseController';

type Request = core.Request;
type Response = core.Response;
type UploadedConversationFile = NonNullable<DomainFileUploadInput['file']>;

export class ConversationController extends BaseController {
  constructor(
    authService: AuthService,
    private rateLimitService: RateLimitService,
    private createConversationUseCase: CreateConversationUseCase,
    private getConversationUseCase: GetConversationUseCase,
    private updateConversationUseCase: UpdateConversationUseCase,
    private archiveConversationUseCase: ArchiveConversationUseCase,
    private listConversationsUseCase: ListConversationsUseCase,
    private deleteConversationUseCase: DeleteConversationUseCase,
    private exportConversationsUseCase: ExportConversationsUseCase,
    private importConversationsUseCase: ImportConversationsUseCase,
    private uploadFileUseCase: UploadFileUseCase,
    logger?: import('../../core/decorators/ILogger').ILogger,
  ) {
    super(authService, logger);
  }

  async createConversation(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      await this.rateLimitService.checkLimit(authContext.userId, 'create_conversation');

      const CreateConversationSchema = z.object({
        name: z.string().optional(),
        participants: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });

      const resultParse = CreateConversationSchema.safeParse(req.body);
      if (!resultParse.success) {
        res.status(400).json(ProtocolUtils.error(
          ProtocolErrorCode.VALIDATION_ERROR,
          'Invalid request body',
          resultParse.error.flatten()
        ));
        return;
      }
      const request = resultParse.data;

      const result = await this.createConversationUseCase.execute({
        userId: authContext.userId,
        title: request.name,
        participantIds: request.participants,
        metadata: request.metadata
      });
 
      if (!result.ok || !result.data) {
        return void this.handleResultError(result, res);
      }
 
      const { conversation } = result.data;
      res.status(201).json(ProtocolUtils.success(conversation));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async getConversations(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);

      const query = req.query as Record<string, unknown>;
      const page = Number.parseInt(String(query.page ?? '1'), 10) || 1;
      const limit = Math.min(
        Number.parseInt(String(query.limit ?? '20'), 10) || 20,
        100
      );
      const offset = (page - 1) * limit;

      const result = await this.listConversationsUseCase.execute({
        userId: authContext.userId,
        limit,
        offset
      });

      if (!result.ok) {
        return void this.handleResultError(result, res);
      }

      res.json(ProtocolUtils.success(result.data));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async getConversation(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      const conversationId = String(req.params?.id ?? '');

      const result = await this.getConversationUseCase.execute({
        conversationId,
        userId: authContext.userId
      });
 
      if (!result.ok || !result.data) {
        return void this.handleResultError(result, res);
      }
 
      const { conversation } = result.data;
      res.json(ProtocolUtils.success(conversation));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async updateConversation(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      const conversationId = String(req.params?.id ?? '');

      const UpdateConversationSchema = z.object({
        name: z.string().optional(),
        title: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });

      const resultParse = UpdateConversationSchema.safeParse(req.body);
      if (!resultParse.success) {
        res.status(400).json(ProtocolUtils.error(
          ProtocolErrorCode.VALIDATION_ERROR,
          'Invalid request body',
          resultParse.error.flatten()
        ));
        return;
      }
      const request = resultParse.data;

      const result = await this.updateConversationUseCase.execute({
        conversationId,
        userId: authContext.userId,
        title: request.title ?? request.name,
        metadata: request.metadata
      });
 
      if (!result.ok || !result.data) {
        return void this.handleResultError(result, res);
      }
 
      const { conversation } = result.data;
      res.json(ProtocolUtils.success(conversation));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async deleteConversation(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      const conversationId = String(req.params?.id ?? '');

      const result = await this.deleteConversationUseCase.execute({
        conversationId,
        userId: authContext.userId
      });

      if (!result.ok) {
        return void this.handleResultError(result, res);
      }

      res.status(204).send();
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async exportConversations(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      
      const ExportConversationsSchema = z.object({
        conversationIds: z.array(z.string()).optional(),
        includeMetadata: z.boolean().optional(),
        format: z.enum(['json', 'csv']).optional(),
      });

      const resultParse = ExportConversationsSchema.safeParse(req.body);
      if (!resultParse.success) {
        res.status(400).json(ProtocolUtils.error(
          ProtocolErrorCode.VALIDATION_ERROR,
          'Invalid request body',
          resultParse.error.flatten()
        ));
        return;
      }
      const request = resultParse.data;

      const result = await this.exportConversationsUseCase.execute({
        userId: authContext.userId,
        conversationIds: request.conversationIds,
        includeMetadata: request.includeMetadata,
        format: request.format
      });
 
      if (!result.ok || !result.data) {
        return void this.handleResultError(result, res);
      }
 
      const { filename, data } = result.data;
 
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(Buffer.from(data, 'base64'));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async importConversations(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      
      const ImportConversationsSchema = z.object({
        data: z.string(),
        mergeStrategy: z.enum(['skip', 'overwrite', 'create_copy']).optional(),
      });

      const resultParse = ImportConversationsSchema.safeParse(req.body);
      if (!resultParse.success) {
        res.status(400).json(ProtocolUtils.error(
          ProtocolErrorCode.VALIDATION_ERROR,
          'Invalid request body',
          resultParse.error.flatten()
        ));
        return;
      }
      const request = resultParse.data;

      const result = await this.importConversationsUseCase.execute({
        userId: authContext.userId,
        data: request.data,
        mergeStrategy: request.mergeStrategy
      });

      if (!result.ok) {
        return void this.handleResultError(result, res);
      }

      res.json(ProtocolUtils.success(result.data));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }

  async uploadFile(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);

      const file = (req as Request & { file?: UploadedConversationFile }).file;
      
      const UploadFileSchema = z.object({
        conversationId: z.string().optional(),
        processAsImages: z.union([
          z.boolean(),
          z.string().transform((val) => val === 'true')
        ]).optional(),
      });

      const resultParse = UploadFileSchema.safeParse(req.body);
      if (!resultParse.success) {
         res.status(400).json(ProtocolUtils.error(
          ProtocolErrorCode.VALIDATION_ERROR,
          'Invalid request body',
          resultParse.error.flatten()
        ));
        return;
      }
      const body = resultParse.data;

      if (!file) {
         res.status(400).json(ProtocolUtils.error(
          ProtocolErrorCode.VALIDATION_ERROR,
          'No file provided'
        ));
        return;
      }

      const result = await this.uploadFileUseCase.execute({
        userId: authContext.userId,
        file,
        conversationId: body.conversationId,
        processAsImages: body.processAsImages
      });

      if (!result.ok) {
        return void this.handleResultError(result, res);
      }

      res.json(ProtocolUtils.success(result.data));
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }
}
