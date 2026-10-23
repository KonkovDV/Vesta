/**
 * SemanticDonorArchive — Infrastructure implementation of ISemanticDonorArchive.
 *
 * Layer: Infrastructure
 *
 * Archives skipped/not-extracted donor files as structured metadata entries
 * before donor offboarding. Currently stores as JSON-based archive files;
 * future phases will integrate with vector embeddings (IEmbeddingProvider)
 * and the Hybrid Semantic Graph (HSG).
 *
 * Uses constructor injection for all dependencies (Hard Rule #13).
 *
 * @see src/domain/extraction/ISemanticDonorArchive.ts — Domain port
 * @see PLANS/DOCS_AUDIT_2026/71_EXTRACTION_V5_SOTA_AUDIT_MARCH_2026.md §2.1
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CorrelationId } from '../../../core/context/IRequestContext';
import type { IStructuredLogger } from '../../../core/logging/IStructuredLogger';
import type {
  ISemanticDonorArchive,
  ArchivedDonorFile,
  SemanticArchiveResult,
  SemanticArchiveQuery,
  SemanticArchiveMatch,
} from '../../../domain/extraction/ISemanticDonorArchive';

/** Directory for semantic archives relative to project root */
const ARCHIVE_DIR = '.extraction-archives';

/** Estimated tokens per line of TypeScript */
const TOKENS_PER_LINE = 8;

/**
 * Infrastructure adapter that persists semantic donor archives
 * as structured JSON files for long-term retrieval.
 */
export class SemanticDonorArchive implements ISemanticDonorArchive {
  constructor(
    private readonly projectRoot: string,
    private readonly logger: IStructuredLogger,
  ) {}

  private get archivePath(): string {
    return path.join(this.projectRoot, ARCHIVE_DIR);
  }

  private donorArchivePath(donorName: string): string {
    return path.join(this.archivePath, `${donorName}.archive.json`);
  }

  async archiveDonor(
    donorPath: string,
    donorName: string,
    skippedFiles: readonly ArchivedDonorFile[],
    correlationId: CorrelationId,
  ): Promise<SemanticArchiveResult> {
    const startTime = Date.now();
    let archivedCount = 0;
    let failedCount = 0;
    let totalTokens = 0;

    // Ensure archive directory exists
    if (!fs.existsSync(this.archivePath)) {
      fs.mkdirSync(this.archivePath, { recursive: true });
    }

    const entries: ArchivedDonorFile[] = [];

    for (const file of skippedFiles) {
      try {
        entries.push(file);
        totalTokens += file.lineCount * TOKENS_PER_LINE;
        archivedCount++;
      } catch {
        failedCount++;
      }
    }

    const archive = {
      donorName,
      donorPath,
      archivedAt: new Date().toISOString(),
      correlationId,
      totalFiles: archivedCount,
      totalTokens,
      entries,
    };

    // Write archive to disk
    const archiveFilePath = this.donorArchivePath(donorName);
    fs.writeFileSync(archiveFilePath, JSON.stringify(archive, null, 2), 'utf-8');

    this.logger.info('Semantic donor archive created', {
      donorName,
      archivedCount,
      failedCount,
      totalTokens,
      durationMs: Date.now() - startTime,
      correlationId,
    });

    return {
      donorName,
      archivedCount,
      failedCount,
      totalTokens,
      archivedAt: archive.archivedAt,
    };
  }

  async searchArchive(
    query: SemanticArchiveQuery,
    correlationId: CorrelationId,
  ): Promise<readonly SemanticArchiveMatch[]> {
    if (!fs.existsSync(this.archivePath)) {
      return [];
    }

    const results: SemanticArchiveMatch[] = [];
    const limit = query.limit ?? 10;
    const queryLower = query.query.toLowerCase();

    const archiveFiles = fs.readdirSync(this.archivePath)
      .filter((f: string) => f.endsWith('.archive.json'));

    for (const archiveFile of archiveFiles) {
      if (query.donorName && !archiveFile.startsWith(query.donorName)) {
        continue;
      }

      const content = fs.readFileSync(
        path.join(this.archivePath, archiveFile),
        'utf-8',
      );
      const archive = JSON.parse(content) as {
        donorName: string;
        entries: ArchivedDonorFile[];
      };

      for (const entry of archive.entries) {
        if (query.skipReason && entry.skipReason !== query.skipReason) {
          continue;
        }

        // Simple keyword-based relevance scoring (future: vector similarity)
        const searchableText = [
          entry.sourcePath,
          entry.classification,
          entry.skipReason,
          ...entry.publicApi,
        ].join(' ').toLowerCase();

        const queryWords = queryLower.split(/\s+/);
        const matchedWords = queryWords.filter((w: string) => searchableText.includes(w));
        const relevance = queryWords.length > 0 ? matchedWords.length / queryWords.length : 0;

        if (relevance > 0) {
          results.push({
            donorName: archive.donorName,
            sourcePath: entry.sourcePath,
            relevance,
            publicApi: entry.publicApi,
            skipReason: entry.skipReason,
            architecturalNotes: `${entry.classification}: ${entry.skipReason} (${entry.lineCount} lines, ${entry.internalDeps} internal deps)`,
          });
        }
      }
    }

    // Sort by relevance descending, then limit
    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit);
  }

  async isDonorArchived(
    donorName: string,
    correlationId: CorrelationId,
  ): Promise<boolean> {
    return fs.existsSync(this.donorArchivePath(donorName));
  }
}
