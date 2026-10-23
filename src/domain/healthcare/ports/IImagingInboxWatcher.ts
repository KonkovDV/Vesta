import type { MriInboxManifest } from '../../../core/events/mri-second-opinion-operations.schemas';

export interface IImagingInboxWatcher {
  pollPendingStudies(limit: number): Promise<readonly MriInboxManifest[]>;
  markAccepted(sourceId: string, metadata?: Record<string, string>): Promise<void>;
  markRejected(sourceId: string, reason: string): Promise<void>;
}