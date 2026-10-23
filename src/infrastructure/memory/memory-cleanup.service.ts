/**
 * Memory Cleanup Service
 * Automatically purges ephemeral thoughts after 24 hours.
 * @layer Infrastructure
 * @singularity Phase 3 Persistence, ADR-008
 */



import { TransientThoughtRepository } from './TransientThoughtRepository';
import { logger } from '../logging/logger';

export class MemoryCleanupService {
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly PURGE_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
  private isRunning = false;

  constructor(private readonly repository: TransientThoughtRepository) {}

  /**
   * Start the cleanup scheduler
   */
  start(): void {
    if (this.cleanupInterval) return;
    
    logger.info('[MemoryCleanupService] Starting 24h auto-purge scheduler');
    this.cleanupInterval = setInterval(() => {
      void this.purgeExpiredThoughts();
    }, this.PURGE_INTERVAL_MS);

    // Run immediately on startup
    void this.purgeExpiredThoughts();
  }

  /**
   * Stop the cleanup scheduler
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    logger.info('[MemoryCleanupService] Stopped 24h auto-purge scheduler');
  }

  close(): void {
    this.stop();
  }

  /**
   * Purge expired thoughts from thought_transient table
   */
  private async purgeExpiredThoughts(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    
    const startTime = Date.now();

    try {
      const deletedCount = await this.repository.deleteExpired();

      if (deletedCount > 0) {
        logger.info(
          `[MemoryCleanupService] Purged ${deletedCount} expired thoughts in ${Date.now() - startTime}ms`
        );
      }
    } catch (error) {
      logger.error('[MemoryCleanupService] Failed to purge expired thoughts:', { error });
    } finally {
      this.isRunning = false;
    }
  }
}
