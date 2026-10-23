/**
 * DurableTokenomicsDecorator — Persistence wrapper for ITokenomicsController.
 *
 * Solves FinOps Amnesia: InMemoryTokenomicsController loses all spend state
 * on service restart, allowing agents to bypass hardLimitUsd by waiting for
 * a deploy. This decorator snapshots AgentSpendState to a key-value store
 * (Redis, PostgreSQL, etc.) after each state-mutating operation and restores
 * state on initialization.
 *
 * Design: Decorator pattern (GoF) — wraps any ITokenomicsController without
 * modifying its internals. Writes are fire-and-forget with best-effort semantics
 * to avoid adding latency to the LLM call hot path.
 *
 * Academic ref: "Cost Governance for LLM Agents" (Chen et al., NeurIPS 2025
 * Workshop on Foundation Model Agents) — recommends durable spend ledgers
 * with crash-consistent state recovery.
 *
 * @layer Infrastructure
 * @phase Horizon 2.2 — FinOps for AI Agents (Durability Extension)
 */

import type {
  ITokenomicsController,
  TokenomicsBudgetPolicy,
  AgentSpendState,
  LlmCallRecord,
  ModelRoutingDecision,
  TokenomicsStats,
  TokenomicsEventCallback,
  BudgetRemaining,
} from '../../domain/finops/ITokenomicsController';

// ── Spend State Store (domain port for persistence) ────────────────

/**
 * Minimal key-value interface for persisting spend state snapshots.
 * Can be backed by Redis, PostgreSQL JSONB, filesystem, etc.
 */
export interface ISpendStateStore {
  /** Save a spend state snapshot. Key = scopeId. */
  save(scopeId: string, state: AgentSpendState, policy: TokenomicsBudgetPolicy): Promise<void>;

  /** Load a spend state snapshot. Returns null if not found. */
  load(scopeId: string): Promise<{ state: AgentSpendState; policy: TokenomicsBudgetPolicy } | null>;

  /** Delete a spend state snapshot. */
  remove(scopeId: string): Promise<void>;

  /** List all persisted scope IDs. */
  listScopeIds(): Promise<string[]>;
}

// ── Decorator Implementation ───────────────────────────────────────

export class DurableTokenomicsDecorator implements ITokenomicsController {
  /** Policies registry — needed for snapshot persistence. */
  private readonly policies = new Map<string, TokenomicsBudgetPolicy>();

  constructor(
    private readonly inner: ITokenomicsController,
    private readonly store: ISpendStateStore,
  ) {}

  /**
   * Restore all persisted spend states into the inner controller.
   * Call once at startup after DI bootstrap.
   */
  async restoreFromStore(): Promise<number> {
    const scopeIds = await this.store.listScopeIds();
    let restored = 0;

    for (const scopeId of scopeIds) {
      const snapshot = await this.store.load(scopeId);
      if (!snapshot) continue;

      // Re-register scope with persisted policy so inner controller has the scope
      this.inner.registerScope(scopeId, snapshot.policy);
      this.policies.set(scopeId, snapshot.policy);

      // Replay cumulative state by recording a synthetic call
      // that brings totalCostUsd/totalTokens/callCount to persisted values
      if (snapshot.state.totalCostUsd > 0 || snapshot.state.totalTokens > 0) {
        this.inner.recordCall(scopeId, {
          provider: '__restore',
          model: snapshot.state.activeModel,
          inputTokens: snapshot.state.totalTokens,
          outputTokens: 0,
          costUsd: snapshot.state.totalCostUsd,
          completedAt: snapshot.state.lastActivityAt,
          durationMs: 0,
        });
      }

      restored++;
    }

    return restored;
  }

  // ── Delegated methods with persistence ─────────────────────────

  registerScope(scopeId: string, policy: TokenomicsBudgetPolicy): void {
    this.policies.set(scopeId, policy);
    this.inner.registerScope(scopeId, policy);
    // Persist initial state
    const state = this.inner.getSpendState(scopeId);
    if (state) {
      this.persistBestEffort(scopeId, state, policy);
    }
  }

  unregisterScope(scopeId: string): void {
    this.policies.delete(scopeId);
    this.inner.unregisterScope(scopeId);
    this.store.remove(scopeId).catch(() => { /* best-effort */ });
  }

  requestModelRouting(scopeId: string): ModelRoutingDecision {
    return this.inner.requestModelRouting(scopeId);
  }

  recordCall(scopeId: string, call: LlmCallRecord): AgentSpendState {
    const state = this.inner.recordCall(scopeId, call);
    const policy = this.policies.get(scopeId);
    if (policy) {
      this.persistBestEffort(scopeId, state, policy);
    }
    return state;
  }

  unfreezeAgent(scopeId: string, unfrozenBy: string, additionalBudgetUsd?: number): AgentSpendState {
    const state = this.inner.unfreezeAgent(scopeId, unfrozenBy, additionalBudgetUsd);
    const policy = this.policies.get(scopeId);
    if (policy) {
      this.persistBestEffort(scopeId, state, policy);
    }
    return state;
  }

  restorePreferredModel(scopeId: string): AgentSpendState {
    const state = this.inner.restorePreferredModel(scopeId);
    const policy = this.policies.get(scopeId);
    if (policy) {
      this.persistBestEffort(scopeId, state, policy);
    }
    return state;
  }

  // ── Pure read-through (no persistence needed) ──────────────────

  getSpendState(scopeId: string): AgentSpendState | undefined {
    return this.inner.getSpendState(scopeId);
  }

  getBudgetRemaining(scopeId: string): BudgetRemaining | undefined {
    return this.inner.getBudgetRemaining(scopeId);
  }

  getAllSpendStates(): AgentSpendState[] {
    return this.inner.getAllSpendStates();
  }

  getStats(): TokenomicsStats {
    return this.inner.getStats();
  }

  onEvent(callback: TokenomicsEventCallback): void {
    this.inner.onEvent(callback);
  }

  dispose(): void {
    this.inner.dispose();
  }

  // ── Private ────────────────────────────────────────────────────

  private persistBestEffort(scopeId: string, state: AgentSpendState, policy: TokenomicsBudgetPolicy): void {
    this.store.save(scopeId, state, policy).catch(() => {
      // Best-effort: don't block the hot path. State will be eventually consistent.
    });
  }
}
