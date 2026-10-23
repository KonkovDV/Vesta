/**
 * Extraction MCP Server — File System Utilities.
 *
 * Layer: Infrastructure (dev-time utility)
 *
 * Provides gitignore-aware recursive file listing, size calculation,
 * and path safety validation. All operations are synchronous and deterministic.
 *
 * Security:
 *   - Path traversal guard: all paths validated against allowed base directories
 *   - No eval(), no exec(), no Function()
 *   - No file content logging (paths/sizes only)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SecurityError, ValidationError } from '../../../../domain/errors/DomainError';

// ── Constants ──────────────────────────────────────────────────────

/** Directories always excluded from scanning. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '__pycache__',
]);

/** Allowed base directories for donor operations. */
const ALLOWED_BASES = ['external'];

// ── Path Safety ────────────────────────────────────────────────────

/**
 * Validate that a resolved path stays within an allowed base directory.
 * Throws SecurityError on path traversal attempts.
 *
 * @param inputPath - User-provided path
 * @param projectRoot - Project root directory
 * @returns Resolved absolute path
 */
export function validateDonorPath(inputPath: string, projectRoot: string): string {
  const resolved = path.resolve(projectRoot, inputPath);
  const isAllowed = ALLOWED_BASES.some((base) => {
    const allowed = path.resolve(projectRoot, base);
    return resolved.startsWith(allowed + path.sep) || resolved === allowed;
  });
  if (!isAllowed) {
    throw new SecurityError(`Path traversal blocked: "${inputPath}" is outside allowed directories (${ALLOWED_BASES.join(', ')})`);
  }
  return resolved;
}

// ── File Listing ───────────────────────────────────────────────────

export interface FileEntry {
  /** Relative path from the base directory. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** File size in bytes. */
  sizeBytes: number;
}

/**
 * Recursively list all TypeScript files in a directory.
 * Respects IGNORED_DIRS and optional .gitignore patterns.
 *
 * @param baseDir - Absolute path to scan
 * @param filter - File extension filter (default: '.ts')
 * @returns Array of FileEntry objects
 */
export function listFilesRecursive(baseDir: string, filter = '.ts'): FileEntry[] {
  return listFilesByExtensionsRecursive(baseDir, [filter]);
}

/**
 * Recursively list files matching any of the provided extensions.
 * Extensions are case-insensitive and must include the leading dot.
 */
export function listFilesByExtensionsRecursive(baseDir: string, extensions: string[]): FileEntry[] {
  if (!fs.existsSync(baseDir)) {
    throw new ValidationError(`Directory does not exist: ${baseDir}`, [
      { field: 'path', message: 'Directory not found', value: baseDir },
    ]);
  }

  const results: FileEntry[] = [];
  const normalizedExtensions = new Set(extensions.map((ext) => ext.toLowerCase()));

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or other FS error — skip silently
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }

      const entryExt = path.extname(entry.name).toLowerCase();
      if (entry.isFile() && normalizedExtensions.has(entryExt)) {
        try {
          const stat = fs.statSync(fullPath);
          results.push({
            relativePath: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
            absolutePath: fullPath,
            sizeBytes: stat.size,
          });
        } catch {
          // File may have been deleted between readdir and stat — skip
        }
      }
    }
  }

  walk(baseDir);
  return results;
}

// ── Size Helpers ───────────────────────────────────────────────────

/**
 * Calculate total size of an array of files in KB.
 */
export function totalSizeKb(files: FileEntry[]): number {
  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  return Math.round((totalBytes / 1024) * 10) / 10;
}

/**
 * Count lines in a file by reading only the first N bytes (default: entire file).
 * Uses synchronous read for deterministic behavior.
 */
export function countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * Read the first N lines of a file (for import analysis).
 */
export function readFirstLines(filePath: string, n = 50): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').slice(0, n);
  } catch {
    return [];
  }
}

// ── Directory Map ──────────────────────────────────────────────────

export interface DirMapEntry {
  dir: string;
  file_count: number;
  size_kb: number;
  top_files: string[];
}

/**
 * Build a directory-level byte map from a list of files.
 *
 * @param files - File entries to aggregate
 * @param topN - Maximum directories to return (default: 20)
 * @returns Array of DirMapEntry sorted by size_kb descending
 */
export function buildDirMap(files: FileEntry[], topN = 20): DirMapEntry[] {
  const dirMap = new Map<string, { totalBytes: number; fileNames: string[] }>();

  for (const file of files) {
    const dir = path.dirname(file.relativePath) || '.';
    const existing = dirMap.get(dir);
    if (existing) {
      existing.totalBytes += file.sizeBytes;
      existing.fileNames.push(path.basename(file.relativePath));
    } else {
      dirMap.set(dir, {
        totalBytes: file.sizeBytes,
        fileNames: [path.basename(file.relativePath)],
      });
    }
  }

  return Array.from(dirMap.entries())
    .map(([dir, data]) => ({
      dir,
      file_count: data.fileNames.length,
      size_kb: Math.round((data.totalBytes / 1024) * 10) / 10,
      top_files: data.fileNames
        .slice(0, 5)
        .sort(),
    }))
    .sort((a, b) => b.size_kb - a.size_kb)
    .slice(0, topN);
}

// ── Git Helpers ────────────────────────────────────────────────────

/** Whitelisted git hosting domains (OWASP ASI01 mitigation). */
export const GIT_DOMAIN_WHITELIST = ['github.com', 'gitlab.com', 'bitbucket.org'] as const;

/**
 * Validate a git URL against the domain whitelist.
 *
 * @param url - Git repository URL
 * @throws SecurityError if domain is not whitelisted
 */
export function validateGitUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SecurityError(`Invalid URL: "${url}"`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isAllowed = GIT_DOMAIN_WHITELIST.some((d) => hostname === d || hostname.endsWith('.' + d));
  if (!isAllowed) {
    throw new SecurityError(
      `Git URL domain "${hostname}" is not in whitelist: ${GIT_DOMAIN_WHITELIST.join(', ')}`,
    );
  }
}
