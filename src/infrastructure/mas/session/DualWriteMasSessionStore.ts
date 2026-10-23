/**
 * DualWriteMasSessionStore - decorator for IMasSessionStore with best-effort secondary writes.
 * Layer: Infrastructure (MAS session).
 *
 * Responsibilities:
 * - delegate all reads to primary store;
 * - perform writes against primary first, then best-effort against secondary;
 * - log failures in secondary via ILogger without failing caller.
 */
import type {
  IMasSessionStore,
  MasSessionState,
} from '../../../domain/mas/mas-session-store';
import type { MasSessionId } from '../../../domain/mas/mas-types';
import type { ILogger } from '../../../core/decorators/ILogger';

export class DualWriteMasSessionStore implements IMasSessionStore {
  constructor(
    private readonly primary: IMasSessionStore,
    private readonly secondary: IMasSessionStore,
    private readonly logger: ILogger | null,
    private readonly readSecondaryFirst: boolean,
  ) {}

  async getSession(sessionId: MasSessionId): Promise<MasSessionState | null> {
    if (!this.readSecondaryFirst) {
      return this.primary.getSession(sessionId);
    }

    // 1) Пробуем Redis (secondary)
    try {
      const fromSecondary = await this.secondary.getSession(sessionId);
      if (fromSecondary) {
        return fromSecondary;
      }
    } catch (error) {
      this.logger?.warn('RedisMasSessionStore dual-read failed', {
        operation: 'getSession',
        sessionId: String(sessionId),
        error,
      });
    }

    // 2) Fallback на primary
    const fromPrimary = await this.primary.getSession(sessionId);

    if (fromPrimary) {
      // 3) Read-through backfill: best-effort запись в secondary (Redis)
      try {
        await this.secondary.saveSession(fromPrimary);
      } catch (error) {
        this.logger?.warn('RedisMasSessionStore read-through backfill failed', {
          operation: 'saveSession',
          sessionId: String(sessionId),
          error,
        });
      }
    }

    return fromPrimary;
  }

  async saveSession(state: MasSessionState): Promise<void> {
    await this.primary.saveSession(state);

    try {
      await this.secondary.saveSession(state);
    } catch (error) {
      this.logSecondaryError('saveSession', state.sessionId, error);
    }
  }

  async deleteSession(sessionId: MasSessionId): Promise<void> {
    await this.primary.deleteSession(sessionId);

    try {
      await this.secondary.deleteSession(sessionId);
    } catch (error) {
      this.logSecondaryError('deleteSession', sessionId, error);
    }
  }

  private logSecondaryError(
    operation: 'saveSession' | 'deleteSession',
    sessionId: MasSessionId,
    error: unknown,
  ): void {
    if (!this.logger || typeof this.logger.warn !== 'function') {
      return;
    }

    this.logger.warn('RedisMasSessionStore dual-write failed', {
      operation,
      sessionId: String(sessionId),
      error:
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : error,
    });
  }

  async listRunnableSessions(limit: number = 50): Promise<MasSessionId[]> {
    if (!this.readSecondaryFirst) {
        return this.primary.listRunnableSessions(limit);
    }
    try {
        const result = await this.secondary.listRunnableSessions(limit);
        if (result.length > 0) return result;
    } catch (error) {
        this.logger?.warn('RedisMasSessionStore listRunnableSessions failed, falling back to primary', { error });
    }
    return this.primary.listRunnableSessions(limit);
  }

  async resetStuckSessions(maxDurationMs: number): Promise<number> {
      // Primary authority
      const resetCount = await this.primary.resetStuckSessions(maxDurationMs);
      
      // Best effort on secondary
      try {
          await this.secondary.resetStuckSessions(maxDurationMs);
      } catch (error) {
           this.logger?.warn('RedisMasSessionStore resetStuckSessions secondary failed', { error });
      }
      
      return resetCount;
  }
}