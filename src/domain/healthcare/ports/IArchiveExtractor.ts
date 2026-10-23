import type { ArchiveExtractionResult } from '../../../core/events/mri-second-opinion-operations.schemas';

export interface IArchiveExtractor {
  extract(sourcePath: string, destinationDir: string): Promise<ArchiveExtractionResult>;
  cleanup(rootDirectory: string): Promise<void>;
}