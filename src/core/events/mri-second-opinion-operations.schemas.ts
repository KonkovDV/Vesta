import { z } from 'zod';

import {
  ClinicalQuestionSchema,
  ImagingStudyRefSchema,
} from './mri-second-opinion.schemas';

export const MriInboxManifestSchema = z.object({
  sourceId: z.string().min(1).max(256),
  sourcePath: z.string().min(1).max(4096),
  archivePath: z.string().min(1).max(4096).optional(),
  discoveredAt: z.string().datetime(),
  clinicalQuestion: ClinicalQuestionSchema.optional(),
  requestedBy: z.string().min(1).max(256).optional(),
  referringPhysician: z.string().min(1).max(128).optional(),
  accessionNumber: z.string().max(16).optional(),
}).strict();

export const ArchiveEntrySchema = z.object({
  relativePath: z.string().min(1).max(4096),
  absolutePath: z.string().min(1).max(4096),
  sizeBytes: z.number().int().nonnegative(),
}).strict();

export const ArchiveExtractionResultSchema = z.object({
  rootDirectory: z.string().min(1).max(4096),
  cleanupRequired: z.boolean(),
  extractedEntries: z.array(ArchiveEntrySchema),
}).strict();

export const ExtractedImagingStudySchema = z.object({
  study: ImagingStudyRefSchema,
  representativeImagePaths: z.array(z.string().min(1).max(4096)).default([]),
  artifactRootDirectory: z.string().min(1).max(4096),
  sourceArchivePath: z.string().min(1).max(4096).optional(),
  derivedClinicalQuestion: ClinicalQuestionSchema.optional(),
}).strict();

export const MriDeliveryJobSchema = z.object({
  jobId: z.string().min(1),
  caseId: z.string().min(1),
  correlationId: z.string().min(1).optional(),
  requestedAt: z.string().datetime(),
}).strict();

export type MriInboxManifest = z.infer<typeof MriInboxManifestSchema>;
export type ArchiveEntry = z.infer<typeof ArchiveEntrySchema>;
export type ArchiveExtractionResult = z.infer<typeof ArchiveExtractionResultSchema>;
export type ExtractedImagingStudy = z.infer<typeof ExtractedImagingStudySchema>;
export type MriDeliveryJob = z.infer<typeof MriDeliveryJobSchema>;