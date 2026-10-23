/**
 * MAS Runtime Core - Autonomous Execution Loop.
 *
 * Layer: Application (services).
 *
 * Responsibility:
 * - Continuously poll for pending/in-progress MAS sessions/tasks.
 * - Delegate execution to TaskOrchestrator.
 * - Handle graceful shutdown and error resilience.
 */
import type { IMasSessionStore } from '../state/mas-session-store';
import { TaskOrchestrator } from '../../orchestration/TaskOrchestrator';
import type { ILogger } from '../../../core/decorators/ILogger';

export class MasExecutionLoop {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly POLLING_INTERVAL_MS = 1000;
  private readonly BATCH_SIZE = 10;
  private lastCleanupTime = 0;

  constructor(
    private readonly sessionStore: IMasSessionStore,
    private readonly orchestrator: TaskOrchestrator,
    private readonly logger?: ILogger
  ) {}

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.logger?.log('[MasExecutionLoop] Starting autonomous execution loop...');
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.logger?.log('[MasExecutionLoop] Stopping execution loop...');
    this.running = false;
    await this.loopPromise;
    this.logger?.log('[MasExecutionLoop] Stopped.');
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const startTime = Date.now();
      try {
        await this.processNextBatch();
      } catch (error) {
        this.logger?.error('[MasExecutionLoop] Error in execution cycle:', { error });
      }

      if (this.running) {

        // R1-C2: Reset stuck sessions periodically (e.g. every 60s)
        // Improved logic: use timestamp delta instead of modulo to avoid skipping under load.
        const now = Date.now();
        if (now - this.lastCleanupTime > 60000) {
             try {
                // 5 minutes stuck threshold
                await this.sessionStore.resetStuckSessions(5 * 60 * 1000);
                this.lastCleanupTime = now;
             } catch (err) {
                 this.logger?.warn('[MasExecutionLoop] Failed to reset stuck sessions', { error: err });
                 // Don't update lastCleanupTime on error to retry sooner? 
                 // Or update to prevent log spam? Let's update to prevent spam.
                 this.lastCleanupTime = now; 
             }
        }

        const elapsed = Date.now() - startTime;
        const delay = Math.max(0, this.POLLING_INTERVAL_MS - elapsed);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async processNextBatch(): Promise<void> {
    // Fetch runnable sessions (active/pending)
    const sessionIds = await this.sessionStore.listRunnableSessions(this.BATCH_SIZE);
    
    if (sessionIds.length === 0) {
      return;
    }

    this.logger?.debug(`[MasExecutionLoop] Found ${sessionIds.length} runnable sessions`);

    // Execute in parallel (with safe limits in Orchestrator/Agents)
    const promises = sessionIds.map(async (sessionId) => {
        try {
            await this.orchestrator.executeSessionStep(sessionId);
        } catch (error) {
            this.logger?.error(`[MasExecutionLoop] Failed to execute step for session ${sessionId}`, { error });
        }
    });

    await Promise.allSettled(promises);
  }
}
