import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  ExtractedImagingStudy,
  MriInboxManifest,
} from '../../../core/events/mri-second-opinion-operations.schemas';
import type { IDicomMetadataExtractor } from '../../../domain/healthcare/ports/IDicomMetadataExtractor';

type ParsedDicomTags = {
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  modality?: string;
  bodyPartExamined?: string;
  studyDate?: string;
  accessionNumber?: string;
  referringPhysician?: string;
};

export class MinimalDicomMetadataExtractor implements IDicomMetadataExtractor {
  async extractStudy(rootDirectory: string, manifest: MriInboxManifest): Promise<ExtractedImagingStudy> {
    const sidecar = await this.tryReadSidecar(rootDirectory, manifest);
    if (sidecar) {
      return sidecar;
    }

    const dicomFiles = await this.findDicomFiles(rootDirectory);
    if (dicomFiles.length === 0) {
      throw new Error(`No DICOM files found under ${rootDirectory}`);
    }

    const seriesUids = new Set<string>();
    let firstTags: ParsedDicomTags | null = null;

    for (const filePath of dicomFiles) {
      const tags = await this.parseDicomTags(filePath);
      if (!tags.studyInstanceUid) {
        continue;
      }
      if (!firstTags) {
        firstTags = tags;
      }
      if (tags.seriesInstanceUid) {
        seriesUids.add(tags.seriesInstanceUid);
      }
    }

    if (!firstTags?.studyInstanceUid) {
      throw new Error(`Unable to derive StudyInstanceUID from DICOM files under ${rootDirectory}`);
    }

    return {
      study: {
        studyInstanceUid: firstTags.studyInstanceUid,
        modality: firstTags.modality ?? 'MR',
        bodyPartExamined: firstTags.bodyPartExamined ?? 'UNKNOWN',
        studyDate: this.normalizeStudyDate(firstTags.studyDate).toISOString(),
        seriesCount: seriesUids.size || 1,
        instanceCount: dicomFiles.length,
        accessionNumber: firstTags.accessionNumber,
        referringPhysician: firstTags.referringPhysician ?? manifest.referringPhysician,
      },
      representativeImagePaths: [],
      artifactRootDirectory: rootDirectory,
      sourceArchivePath: manifest.archivePath,
      derivedClinicalQuestion: manifest.clinicalQuestion,
    };
  }

  private async tryReadSidecar(
    rootDirectory: string,
    manifest: MriInboxManifest,
  ): Promise<ExtractedImagingStudy | null> {
    for (const fileName of ['study-metadata.json', 'mri-study.json']) {
      const candidate = path.join(rootDirectory, fileName);
      try {
        const raw = await fs.readFile(candidate, 'utf8');
        const parsed = JSON.parse(raw) as ExtractedImagingStudy;
        return {
          ...parsed,
          artifactRootDirectory: parsed.artifactRootDirectory ?? rootDirectory,
          sourceArchivePath: parsed.sourceArchivePath ?? manifest.archivePath,
          derivedClinicalQuestion: parsed.derivedClinicalQuestion ?? manifest.clinicalQuestion,
        };
      } catch {
        // ignore and continue
      }
    }
    return null;
  }

  private async findDicomFiles(rootDirectory: string): Promise<string[]> {
    const results: string[] = [];
    await this.walk(rootDirectory, results);
    return results;
  }

  private async walk(currentPath: string, acc: string[]): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await this.walk(absolutePath, acc);
        continue;
      }
      const buffer = await fs.readFile(absolutePath);
      if (buffer.length > 132 && buffer.toString('ascii', 128, 132) === 'DICM') {
        acc.push(absolutePath);
      }
    }
  }

  private async parseDicomTags(filePath: string): Promise<ParsedDicomTags> {
    const buffer = await fs.readFile(filePath);
    const tags: ParsedDicomTags = {};
    let offset = 132;

    while (offset + 8 <= buffer.length && offset < Math.min(buffer.length, 65536)) {
      const group = buffer.readUInt16LE(offset);
      const element = buffer.readUInt16LE(offset + 2);
      const vr = buffer.toString('ascii', offset + 4, offset + 6);

      let valueLength: number;
      let valueOffset: number;
      if (['OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN'].includes(vr)) {
        valueLength = buffer.readUInt32LE(offset + 8);
        valueOffset = offset + 12;
      } else {
        valueLength = buffer.readUInt16LE(offset + 6);
        valueOffset = offset + 8;
      }

      if (valueLength < 0 || valueOffset + valueLength > buffer.length) {
        break;
      }

      const tagKey = `${group.toString(16).padStart(4, '0')},${element.toString(16).padStart(4, '0')}`;
      const value = buffer
        .toString('utf8', valueOffset, valueOffset + valueLength)
        .replace(/\0/g, '')
        .trim();

      if (tagKey === '0020,000d') tags.studyInstanceUid = value;
      if (tagKey === '0020,000e') tags.seriesInstanceUid = value;
      if (tagKey === '0008,0060') tags.modality = value;
      if (tagKey === '0018,0015') tags.bodyPartExamined = value;
      if (tagKey === '0008,0020') tags.studyDate = value;
      if (tagKey === '0008,0050') tags.accessionNumber = value;
      if (tagKey === '0008,0090') tags.referringPhysician = value;

      if (tags.studyInstanceUid && tags.seriesInstanceUid && tags.modality && tags.studyDate) {
        // continue scanning for optional tags only if cheap; otherwise exit early
      }

      offset = valueOffset + valueLength;
      if (valueLength % 2 !== 0) {
        offset += 1;
      }
    }

    return tags;
  }

  private normalizeStudyDate(input?: string): Date {
    if (!input || input.length < 8) {
      return new Date();
    }

    const year = Number(input.slice(0, 4));
    const month = Number(input.slice(4, 6)) - 1;
    const day = Number(input.slice(6, 8));
    const result = new Date(Date.UTC(year, month, day));
    return Number.isNaN(result.getTime()) ? new Date() : result;
  }
}