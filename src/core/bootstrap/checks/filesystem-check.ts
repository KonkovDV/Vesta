/**
 * File System Check
 * Validates required directories exist and have proper permissions
 */

import { BaseIntegrityCheck, CheckResult } from '../system-integrity-checker';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface DirectoryRequirement {
  path: string;
  writable?: boolean;
  readable?: boolean;
  createIfMissing?: boolean;
}

export class FileSystemCheck extends BaseIntegrityCheck {
  readonly name = 'filesystem';
  readonly description = 'Validates file system permissions and required directories';
  readonly priority = 5;
  readonly severity = 'critical';
  readonly timeoutMs = 3000;

  private readonly directories: DirectoryRequirement[];

  constructor(directories?: DirectoryRequirement[], rootDir?: string) {
    super();
    this.directories = directories ?? this.getDefaultDirectories(rootDir);
  }

  private getDefaultDirectories(rootDir?: string): DirectoryRequirement[] {
    const root = rootDir ?? process.cwd();
    return [
      { path: root, readable: true, writable: false },
      { path: path.join(root, 'logs'), writable: true, createIfMissing: true },
      { path: path.join(root, 'temp'), writable: true, createIfMissing: true },
      { path: path.join(root, 'uploads'), writable: true, createIfMissing: true },
    ];
  }

  async check(): Promise<CheckResult> {
    const errors: string[] = [];
    const created: string[] = [];
    const verified: Array<{ path: string; readable: boolean; writable: boolean }> = [];

    for (const dir of this.directories) {
      try {
        const result = await this.checkDirectory(dir);
        if (result.created) {
          created.push(dir.path);
        }
        verified.push({ path: dir.path, readable: result.readable, writable: result.writable });

        if (!result.exists) {
          errors.push(`Directory does not exist and could not be created: ${dir.path}`);
        } else if (dir.readable && !result.readable) {
          errors.push(`Directory not readable: ${dir.path}`);
        } else if (dir.writable && !result.writable) {
          errors.push(`Directory not writable: ${dir.path}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(`Error checking ${dir.path}: ${errorMessage}`);
      }
    }

    if (errors.length > 0) {
      return this.fail(`File system check failed: ${errors.join('; ')}`, {
        verified,
        created,
        errors,
      });
    }

    const details: Record<string, unknown> = {
      verified: verified.length,
      directories: verified.map(v => v.path),
    };

    if (created.length > 0) {
      details.created = created;
    }

    return this.pass('File system permissions verified', details);
  }

  private async checkDirectory(
    req: DirectoryRequirement
  ): Promise<{ exists: boolean; readable: boolean; writable: boolean; created: boolean }> {
    let exists = false;
    let readable = false;
    let writable = false;
    let created = false;

    try {
      await fs.access(req.path);
      exists = true;
    } catch {
      // Directory doesn't exist
      if (req.createIfMissing) {
        try {
          await fs.mkdir(req.path, { recursive: true });
          exists = true;
          created = true;
        } catch {
          exists = false;
        }
      }
    }

    if (exists) {
      // Check readability
      if (req.readable !== false) {
        readable = await fs.access(req.path, fs.constants.R_OK).then(() => true, () => false);
      } else {
        readable = true; // Not required, mark as ok
      }

      // Check writability
      if (req.writable) {
        try {
          const testFile = path.join(req.path, `.write-test-${Date.now()}`);
          await fs.writeFile(testFile, '');
          await fs.unlink(testFile);
          writable = true;
        } catch {
          writable = false;
        }
      } else {
        writable = true; // Not required, mark as ok
      }
    }

    return { exists, readable, writable, created };
  }
}
