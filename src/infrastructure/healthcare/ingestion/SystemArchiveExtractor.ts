import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ArchiveExtractionResult } from '../../../core/events/mri-second-opinion-operations.schemas';
import type { IArchiveExtractor } from '../../../domain/healthcare/ports/IArchiveExtractor';
import type { IPlatformAdapter } from '../../../domain/platform/IPlatformAdapter';

const execFileAsync = promisify(execFile);

export class SystemArchiveExtractor implements IArchiveExtractor {
  constructor(private readonly platformAdapter: IPlatformAdapter) {}

  async extract(sourcePath: string, destinationDir: string): Promise<ArchiveExtractionResult> {
    const stat = await fs.stat(sourcePath);

    if (stat.isDirectory()) {
      const extractedEntries = await this.listEntries(sourcePath);
      return {
        rootDirectory: sourcePath,
        cleanupRequired: false,
        extractedEntries,
      };
    }

    if (!sourcePath.toLowerCase().endsWith('.zip')) {
      throw new Error(`Unsupported archive format: ${sourcePath}`);
    }

    await fs.mkdir(destinationDir, { recursive: true });

    if (this.platformAdapter.isWindows()) {
      await execFileAsync('powershell', [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `$ProgressPreference = 'SilentlyContinue'; Expand-Archive -Path '${sourcePath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`,
      ]);
    } else {
      await execFileAsync('unzip', ['-o', '-q', sourcePath, '-d', destinationDir]);
    }

    return {
      rootDirectory: destinationDir,
      cleanupRequired: true,
      extractedEntries: await this.listEntries(destinationDir),
    };
  }

  async cleanup(rootDirectory: string): Promise<void> {
    await fs.rm(rootDirectory, { recursive: true, force: true });
  }

  private async listEntries(rootDirectory: string): Promise<ArchiveExtractionResult['extractedEntries']> {
    const entries: ArchiveExtractionResult['extractedEntries'] = [];
    await this.walk(rootDirectory, rootDirectory, entries);
    return entries;
  }

  private async walk(
    currentPath: string,
    rootDirectory: string,
    acc: ArchiveExtractionResult['extractedEntries'],
  ): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await this.walk(absolutePath, rootDirectory, acc);
        continue;
      }

      const stat = await fs.stat(absolutePath);
      acc.push({
        relativePath: path.relative(rootDirectory, absolutePath),
        absolutePath,
        sizeBytes: stat.size,
      });
    }
  }
}