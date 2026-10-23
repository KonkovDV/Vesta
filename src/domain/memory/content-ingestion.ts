/**
 * Multimodal Ingestion Types and Interfaces.
 * 
 * Defines types for PDF and Image ingestion into memory.
 * 
 * Layer: Domain
 */

import type { TenantId, UserId, SessionId, CorrelationId } from './session-types';

/**
 * Supported content types for ingestion.
 */
export type IngestibleContentType = 
  | 'pdf'
  | 'image'
  | 'text'
  | 'url'
  | 'audio';

/**
 * Base input for content ingestion.
 */
export interface IngestContentInput {
  tenantId: TenantId;
  userId: UserId;
  sessionId?: SessionId;
  contentType: IngestibleContentType;
  correlationId?: CorrelationId;
  metadata?: Record<string, unknown>;
  /** Caller accepts an untrusted fact. Required for URL, PDF, and image. */
  confirmed?: boolean;
}

/**
 * PDF ingestion input.
 */
export interface IngestPDFInput extends IngestContentInput {
  contentType: 'pdf';
  /** URL to PDF file or base64-encoded content */
  source: string;
  /** Whether source is base64 encoded */
  isBase64?: boolean;
  /** Optional prompt for extraction */
  extractionPrompt?: string;
}

/**
 * Image ingestion input.
 */
export interface IngestImageInput extends IngestContentInput {
  contentType: 'image';
  /** Base64-encoded image data */
  imageBase64: string;
  /** Image MIME type */
  mimeType?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Optional prompt for vision analysis */
  analysisPrompt?: string;
}

/**
 * Text ingestion input.
 */
export interface IngestTextInput extends IngestContentInput {
  contentType: 'text';
  /** Raw text content */
  text: string;
}

/**
 * URL ingestion input.
 */
export interface IngestURLInput extends IngestContentInput {
  contentType: 'url';
  /** URL to scrape */
  url: string;
}

/**
 * Ingested fact from content.
 */
export interface IngestedFact {
  /** Unique identifier */
  id: string;
  /** Extracted fact text */
  fact: string;
  /** Source reference (page, timestamp, etc.) */
  sourceRef?: string;
  /** Confidence score [0, 1] */
  confidence: number;
  /** Original content chunk this was extracted from */
  chunk?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of content ingestion.
 */
export interface IngestRejection {
  reason: string;
  count: number;
}

export interface IngestContentResult {
  /** Number of chunks processed */
  chunksProcessed: number;
  /** Extracted facts */
  facts: IngestedFact[];
  /** Processing time in ms */
  processingTimeMs: number;
  /** Any warnings during processing */
  warnings?: string[];
  /** Facts newly written for this tenant and user. */
  stored?: number;
  /** Facts already open for this tenant and user, so they were not written again. */
  duplicates?: number;
  /** Facts the gate refused, grouped by reason. */
  rejected?: IngestRejection[];
  /** Id of the content-ingestion event that precedes the fact proposals. */
  originEventId?: string;
}

export interface IngestedFactDecision {
  accepted: boolean;
  alreadyStored?: boolean;
  reason?: string;
}

/**
 * Writes one ingestion event, then each extracted fact through the fact gate.
 */
export interface IngestedFactRecorder {
  begin(input: {
    tenantId: string;
    userId: string;
    contentType: IngestibleContentType;
    contentHash: string;
    correlationId?: string;
  }): Promise<{ originEventId: string }>;
  propose(input: {
    tenantId: string;
    userId: string;
    originEventId: string;
    fact: string;
    confidence: number;
    confirmed?: boolean;
    untrusted: boolean;
    correlationId?: string;
  }): Promise<IngestedFactDecision>;
}

/**
 * Content Ingestion Service interface.
 */
export interface IContentIngestionService {
  /**
   * Ingest PDF document and extract facts.
   */
  ingestPDF(input: IngestPDFInput): Promise<IngestContentResult>;

  /**
   * Ingest image using vision model.
   */
  ingestImage(input: IngestImageInput): Promise<IngestContentResult>;

  /**
   * Ingest raw text content.
   */
  ingestText(input: IngestTextInput): Promise<IngestContentResult>;

  /**
   * Ingest content from URL.
   */
  ingestURL(input: IngestURLInput): Promise<IngestContentResult>;

  /**
   * Get supported content types.
   */
  getSupportedTypes(): IngestibleContentType[];
}

/**
 * Chunking configuration for large documents.
 */
export interface ChunkingConfig {
  /** Maximum tokens per chunk */
  maxTokensPerChunk: number;
  /** Overlap between chunks */
  overlapTokens: number;
  /** Whether to preserve sentence boundaries */
  preserveSentences: boolean;
}

/**
 * Default chunking configuration.
 */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxTokensPerChunk: 2048,
  overlapTokens: 256,
  preserveSentences: true,
};
