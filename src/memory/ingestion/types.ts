/**
 * Ingestion contracts live in the domain. This module re-exports them.
 * Layer: Memory
 */
export {
  type IngestibleContentType,
  type IngestContentInput,
  type IngestPDFInput,
  type IngestImageInput,
  type IngestTextInput,
  type IngestURLInput,
  type IngestedFact,
  type IngestRejection,
  type IngestContentResult,
  type IngestedFactDecision,
  type IngestedFactRecorder,
  type IContentIngestionService,
  type ChunkingConfig,
  DEFAULT_CHUNKING_CONFIG,
} from '../../domain/memory/content-ingestion';
