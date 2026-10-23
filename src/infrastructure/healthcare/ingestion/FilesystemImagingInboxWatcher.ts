import fs from 'node:fs/promises';
import path from 'node:path';

import {
  MriInboxManifestSchema,
  type MriInboxManifest,
} from '../../../core/events/mri-second-opinion-operations.schemas';
import type { IImagingInboxWatcher } from '../../../domain/healthcare/ports/IImagingInboxWatcher';

interface LoggerLike {
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface FilesystemImagingInboxWatcherOptions {
  readonly inboxDir: string;
  readonly processedDir: string;
  readonly rejectedDir: string;
}

interface PendingSource {
  readonly manifest: MriInboxManifest;
  readonly manifestPath?: string;
  readonly assetPath: string;
}

export class FilesystemImagingInboxWatcher implements IImagingInboxWatcher {
  private readonly pendingById = new Map<string, PendingSource>();

  constructor(
    private readonly options: FilesystemImagingInboxWatcherOptions,
    private readonly logger?: LoggerLike,
  ) {}

  async pollPendingStudies(limit: number): Promise<readonly MriInboxManifest[]> {
    await this.ensureDirectories();
    const entries = await fs.readdir(this.options.inboxDir, { withFileTypes: true });
    const manifests: MriInboxManifest[] = [];

    for (const entry of entries) {
      if (manifests.length >= limit) break;
      const fullPath = path.join(this.options.inboxDir, entry.name);

      if (entry.isFile() && entry.name.endsWith('.json')) {
        const parsed = await this.parseManifestFile(fullPath);
        if (parsed && !this.pendingById.has(parsed.sourceId)) {
          this.pendingById.set(parsed.sourceId, {
            manifest: parsed,
            manifestPath: fullPath,
            assetPath: parsed.archivePath ?? parsed.sourcePath,
          });
          manifests.push(parsed);
        }
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
        const sourceId = this.sourceIdFromName(entry.name);
        if (this.pendingById.has(sourceId)) continue;
        const manifest = MriInboxManifestSchema.parse({
          sourceId,
          sourcePath: fullPath,
          archivePath: fullPath,
          discoveredAt: new Date().toISOString(),
        });
        this.pendingById.set(sourceId, { manifest, assetPath: fullPath });
        manifests.push(manifest);
        continue;
      }

      if (entry.isDirectory()) {
        const sourceId = this.sourceIdFromName(entry.name);
        if (this.pendingById.has(sourceId)) continue;
        const manifest = MriInboxManifestSchema.parse({
          sourceId,
          sourcePath: fullPath,
          discoveredAt: new Date().toISOString(),
        });
        this.pendingById.set(sourceId, { manifest, assetPath: fullPath });
        manifests.push(manifest);
      }
    }

    return manifests;
  }

  async markAccepted(sourceId: string, metadata?: Record<string, string>): Promise<void> {
    const pending = this.pendingById.get(sourceId);
    if (!pending) return;

    await this.moveToTerminalDir(pending, this.options.processedDir, metadata);
    this.pendingById.delete(sourceId);
  }

  async markRejected(sourceId: string, reason: string): Promise<void> {
    const pending = this.pendingById.get(sourceId);
    if (!pending) return;

    await this.moveToTerminalDir(pending, this.options.rejectedDir, { reason });
    this.pendingById.delete(sourceId);
  }

  private async ensureDirectories(): Promise<void> {
    const results = await Promise.allSettled([
      fs.mkdir(this.options.inboxDir, { recursive: true }),
      fs.mkdir(this.options.processedDir, { recursive: true }),
      fs.mkdir(this.options.rejectedDir, { recursive: true }),
    ]);

    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) {
      throw rejected.reason;
    }
  }

  private async parseManifestFile(filePath: string): Promise<MriInboxManifest | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = MriInboxManifestSchema.parse(JSON.parse(raw));
      return parsed;
    } catch (error) {
      this.logger?.warn?.('[FilesystemImagingInboxWatcher] Invalid manifest skipped', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async moveToTerminalDir(
    pending: PendingSource,
    targetDir: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const targetRoot = path.join(targetDir, pending.manifest.sourceId);
    await fs.mkdir(targetRoot, { recursive: true });

    const assetTarget = path.join(targetRoot, path.basename(pending.assetPath));
    if (await this.exists(pending.assetPath)) {
      await fs.rename(pending.assetPath, assetTarget).catch(async () => {
        await fs.cp(pending.assetPath, assetTarget, { recursive: true, force: true });
        await fs.rm(pending.assetPath, { recursive: true, force: true });
      });
    }

    const manifestPath = pending.manifestPath;
    if (manifestPath && await this.exists(manifestPath)) {
      await fs.rename(
        manifestPath,
        path.join(targetRoot, path.basename(manifestPath)),
      ).catch(async () => {
        await fs.copyFile(
          manifestPath,
          path.join(targetRoot, path.basename(manifestPath)),
        );
        await fs.rm(manifestPath, { force: true });
      });
    }

    if (metadata) {
      await fs.writeFile(
        path.join(targetRoot, 'ingestion-result.json'),
        JSON.stringify(metadata, null, 2),
        'utf8',
      );
    }
  }

  private sourceIdFromName(name: string): string {
    return name.replace(/\.[^.]+$/, '').replace(/[^0-9a-zA-Z_-]+/g, '_');
  }

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}