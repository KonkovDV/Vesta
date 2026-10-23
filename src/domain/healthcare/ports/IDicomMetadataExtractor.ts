import type {
  ExtractedImagingStudy,
  MriInboxManifest,
} from '../../../core/events/mri-second-opinion-operations.schemas';

export interface IDicomMetadataExtractor {
  extractStudy(rootDirectory: string, manifest: MriInboxManifest): Promise<ExtractedImagingStudy>;
}