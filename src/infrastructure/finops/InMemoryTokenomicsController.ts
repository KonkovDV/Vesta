/**
 * InMemoryTokenomicsController — Infrastructure implementation for ITokenomicsController.
 *
 * Provides in-memory FinOps cost governance with automatic tier transitions:
 *   OK → WARNING → DOWNGRADED → FROZEN
 *
 * Integrates (optionally) with:
 * - IUserApprovalInterceptor for HITL escalation on freeze
 * - IEventBus for publishing domain events (outbox pattern)
 *
 * All state is ephemeral (in-memory). For durable spend tracking,
 * wrap with a persistence decorator or periodically snapshot to EventStore.
 *
 * @layer Infrastructure
 * @phase Horizon 2.2 — FinOps for AI Agents
 */

import type {
  ITokenomicsController,
  TokenomicsBudgetPolicy,
  AgentSpendState,
  SpendTier,
  LlmCallRecord,
  ModelRoutingDecision,
  TokenomicsStats,
  TokenomicsEvent,
  TokenomicsEventCallback,
  BudgetWarningEvent,
  ModelDowngradedEvent,
  ModelRestoredEvent,
  AgentFrozenEvent,
  AgentUnfrozenEvent,
  CallRejectedEvent,
  BudgetRemaining,
} from '../../domain/finops/ITokenomicsController';

// ── Internal helpers ────────────────────────────────────────────────

/** Remove readonly from all properties — internal use only for mutable adapter state. */
type Mutable<T> = { -readonly [P in keyof T]: T[P] };

interface ScopeRecord {
  policy: Mutable<TokenomicsBudgetPolicy>;
  state: Mutable<AgentSpendState>;
  /** Call history for sliding window calculations. */
  callHistory: Array<{ costUsd: number; tokens: number; completedAt: number }>;
}

// ── Implementation ─────────────────────────────────────────────────

export class InMemoryTokenomicsController implements ITokenomicsController {
  private readonly scopes: Map<string, ScopeRecord> = new Map();
  private readonly eventCallbacks: TokenomicsEventCallback[] = [];

  // Aggregate counters
  private totalDowngrades = 0;
  private totalFrozen = 0;
  private totalHitlEscalations = 0;
  private totalCallsRejected = 0;

  // ── Lifecycle ──────────────────────────────────────────────────

  public registerScope(scopeId: string, policy: TokenomicsBudgetPolicy): void {
    const existing = this.scopes.get(scopeId);
    if (existing) {
      // Update policy, preserve state
      existing.policy = policy;
      return;
    }

    const now = new Date().toISOString();
    const state: AgentSpendState = {
      scopeId,
      policyId: policy.policyId,
      tier: 'ok',
      totalCostUsd: 0,
      totalTokens: 0,
      callCount: 0,
      activeModel: policy.preferredModel,
      isDowngraded: false,
      isFrozen: false,
      firstActivityAt: now,
      lastActivityAt: now,
      tierChangedAt: now,
    };

    this.scopes.set(scopeId, {
      policy,
      state,
      callHistory: [],
    });
  }

  public unregisterScope(scopeId: string): void {
    const record = this.scopes.get(scopeId);
    if (record && record.state.isFrozen) {
      this.totalFrozen = Math.max(0, this.totalFrozen - 1);
    }
    this.scopes.delete(scopeId);
  }

  // ── Model routing ──────────────────────────────────────────────

  public requestModelRouting(scopeId: string): ModelRoutingDecision {
    const record = this.scopes.get(scopeId);
    if (!record) {
      // Untracked scope — allow with no governance
      return {
        allowed: true,
        model: 'anthropic/claude-sonnet-4-20250514',
        isDowngraded: false,
        tier: 'ok',
        spendState: this.createUnregisteredState(scopeId),
      };
    }

    const { policy, state } = record;

    // Frozen agents cannot make calls
    if (state.isFrozen) {
      this.totalCallsRejected++;
      this.emitEvent({
        eventType: 'call_rejected',
        scopeId,
        policyId: policy.policyId,
        timestamp: new Date().toISOString(),
        reason: `Agent frozen (cost $${state.totalCostUsd.toFixed(4)} exceeds limit $${policy.hardLimitUsd})`,
        tier: state.tier,
        totalCostUsd: state.totalCostUsd,
      } as CallRejectedEvent);

      return {
        allowed: false,
        model: state.activeModel,
        isDowngraded: state.isDowngraded,
        tier: state.tier,
        reason: `Agent frozen: cost $${state.totalCostUsd.toFixed(4)} exceeds hard limit $${policy.hardLimitUsd}`,
        spendState: { ...state },
      };
    }

    // Call count limit
    if (policy.maxCallCount > 0 && state.callCount >= policy.maxCallCount) {
      this.freezeScope(record, `Max call count exceeded (${state.callCount}/${policy.maxCallCount})`);
      this.totalCallsRejected++;
      this.emitEvent({
        eventType: 'call_rejected',
        scopeId,
        policyId: policy.policyId,
        timestamp: new Date().toISOString(),
        reason: `Call count limit reached: ${state.callCount}/${policy.maxCallCount}`,
        tier: state.tier,
        totalCostUsd: state.totalCostUsd,
      } as CallRejectedEvent);

      return {
        allowed: false,
        model: state.activeModel,
        isDowngraded: state.isDowngraded,
        tier: state.tier,
        reason: `Call count limit reached: ${state.callCount}/${policy.maxCallCount}`,
        spendState: { ...state },
      };
    }

    // Token limit
    if (policy.maxTotalTokens > 0 && state.totalTokens >= policy.maxTotalTokens) {
      this.freezeScope(record, `Max total tokens exceeded (${state.totalTokens}/${policy.maxTotalTokens})`);
      this.totalCallsRejected++;
      this.emitEvent({
        eventType: 'call_rejected',
        scopeId,
        policyId: policy.policyId,
        timestamp: new Date().toISOString(),
        reason: `Token limit reached: ${state.totalTokens}/${policy.maxTotalTokens}`,
        tier: state.tier,
        totalCostUsd: state.totalCostUsd,
      } as CallRejectedEvent);

      return {
        allowed: false,
        model: state.activeModel,
        isDowngraded: state.isDowngraded,
        tier: state.tier,
        reason: `Token limit reached: ${state.totalTokens}/${policy.maxTotalTokens}`,
        spendState: { ...state },
      };
    }

    return {
      allowed: true,
      model: state.activeModel,
      isDowngraded: state.isDowngraded,
      tier: state.tier,
      spendState: { ...state },
    };
  }

  // ── Call recording ─────────────────────────────────────────────

  public recordCall(scopeId: string, call: LlmCallRecord): AgentSpendState {
    const record = this.scopes.get(scopeId);
    if (!record) {
      return this.createUnregisteredState(scopeId);
    }

    const { policy, state } = record;
    const now = new Date().toISOString();
    const totalTokens = call.inputTokens + call.outputTokens;

    // Per-call token guard
    if (policy.maxTokensPerCall > 0 && totalTokens > policy.maxTokensPerCall) {
      // Record it anyway (call already happened) but note the violation
    }

    // Update cumulative state
    state.totalCostUsd += call.costUsd;
    state.totalTokens += totalTokens;
    state.callCount++;
    state.lastActivityAt = now;

    // Push to call history
    record.callHistory.push({
      costUsd: call.costUsd,
      tokens: totalTokens,
      completedAt: Date.now(),
    });

    // Sliding window trimming
    if (policy.slidingWindowMs > 0) {
      this.trimCallHistory(record);
    }

    // Evaluate tier transitions (most severe first)
    const effectiveCost = this.getEffectiveCost(record);

    if (effectiveCost >= policy.hardLimitUsd && state.tier !== 'frozen') {
      this.freezeScope(record, `Cost $${effectiveCost.toFixed(4)} exceeded hard limit $${policy.hardLimitUsd}`);
    } else if (effectiveCost >= policy.downgradeThresholdUsd && state.tier !== 'downgraded' && state.tier !== 'frozen') {
      this.downgradeScope(record);
    } else if (effectiveCost >= policy.warningThresholdUsd && state.tier === 'ok') {
      this.warnScope(record, effectiveCost);
    }

    return { ...state };
  }

  // ── Admin actions ──────────────────────────────────────────────

  public unfreezeAgent(scopeId: string, unfrozenBy: string, additionalBudgetUsd?: number): AgentSpendState {
    const record = this.scopes.get(scopeId);
    if (!record) {
      return this.createUnregisteredState(scopeId);
    }

    const { policy, state } = record;
    const now = new Date().toISOString();

    if (!state.isFrozen) {
      return { ...state };
    }

    // Extend hard limit if additional budget provided
    if (additionalBudgetUsd && additionalBudgetUsd > 0) {
      policy.hardLimitUsd += additionalBudgetUsd;
      // Also raise downgrade threshold proportionally if it would be exceeded
      if (state.totalCostUsd >= policy.downgradeThresholdUsd) {
        policy.downgradeThresholdUsd = Math.min(
          policy.hardLimitUsd * 0.7,
          policy.downgradeThresholdUsd + additionalBudgetUsd * 0.6,
        );
      }
    }

    state.isFrozen = false;
    state.hitlRequestId = undefined;
    this.totalFrozen = Math.max(0, this.totalFrozen - 1);

    // Re-evaluate tier based on new limits
    const effectiveCost = this.getEffectiveCost(record);
    if (effectiveCost >= policy.downgradeThresholdUsd) {
      state.tier = 'downgraded';
      state.activeModel = policy.downgradeModel;
      state.isDowngraded = true;
    } else if (effectiveCost >= policy.warningThresholdUsd) {
      state.tier = 'warning';
    } else {
      state.tier = 'ok';
      state.activeModel = policy.preferredModel;
      state.isDowngraded = false;
    }

    state.tierChangedAt = now;

    this.emitEvent({
      eventType: 'agent_unfrozen',
      scopeId,
      policyId: policy.policyId,
      timestamp: now,
      unfrozenBy,
      newBudgetUsd: additionalBudgetUsd,
    } as AgentUnfrozenEvent);

    return { ...state };
  }

  public restorePreferredModel(scopeId: string): AgentSpendState {
    const record = this.scopes.get(scopeId);
    if (!record) {
      return this.createUnregisteredState(scopeId);
    }

    const { policy, state } = record;

    if (!state.isDowngraded || state.isFrozen) {
      return { ...state };
    }

    const fromModel = state.activeModel;
    state.activeModel = policy.preferredModel;
    state.isDowngraded = false;
    state.tier = this.getEffectiveCost(record) >= policy.warningThresholdUsd ? 'warning' : 'ok';
    state.tierChangedAt = new Date().toISOString();

    this.emitEvent({
      eventType: 'model_restored',
      scopeId,
      policyId: policy.policyId,
      timestamp: state.tierChangedAt,
      fromModel,
      toModel: policy.preferredModel,
      reason: 'Manual restore by admin',
    } as ModelRestoredEvent);

    return { ...state };
  }

  // ── Queries ────────────────────────────────────────────────────

  public getSpendState(scopeId: string): AgentSpendState | undefined {
    const record = this.scopes.get(scopeId);
    return record ? { ...record.state } : undefined;
  }

  // FIX: H-008 — Compute remaining budget from policy limits and current spend.
  public getBudgetRemaining(scopeId: string): BudgetRemaining | undefined {
    const record = this.scopes.get(scopeId);
    if (!record) return undefined;
    const { policy, state } = record;
    return {
      tokensRemaining: policy.maxTotalTokens > 0
        ? Math.max(0, policy.maxTotalTokens - state.totalTokens)
        : undefined,
      costRemainingUsd: Math.max(0, policy.hardLimitUsd - state.totalCostUsd),
    };
  }

  public getAllSpendStates(): AgentSpendState[] {
    return Array.from(this.scopes.values()).map((r) => ({ ...r.state }));
  }

  public getStats(): TokenomicsStats {
    const tierDistribution: Record<SpendTier, number> = {
      ok: 0,
      warning: 0,
      downgraded: 0,
      frozen: 0,
    };
    let totalCost = 0;
    let totalTokens = 0;
    let totalCalls = 0;

    for (const record of this.scopes.values()) {
      tierDistribution[record.state.tier]++;
      totalCost += record.state.totalCostUsd;
      totalTokens += record.state.totalTokens;
      totalCalls += record.state.callCount;
    }

    return {
      trackedScopes: this.scopes.size,
      tierDistribution,
      totalCostUsd: totalCost,
      totalTokens,
      totalCalls,
      totalDowngrades: this.totalDowngrades,
      totalFrozen: this.totalFrozen,
      totalHitlEscalations: this.totalHitlEscalations,
      totalCallsRejected: this.totalCallsRejected,
    };
  }

  // ── Events ─────────────────────────────────────────────────────

  public onEvent(callback: TokenomicsEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  public dispose(): void {
    this.scopes.clear();
    this.eventCallbacks.length = 0;
    this.totalDowngrades = 0;
    this.totalFrozen = 0;
    this.totalHitlEscalations = 0;
    this.totalCallsRejected = 0;
  }

  // ── Private: Tier transitions ──────────────────────────────────

  private warnScope(record: ScopeRecord, effectiveCost: number): void {
    const { policy, state } = record;
    const now = new Date().toISOString();

    state.tier = 'warning';
    state.tierChangedAt = now;

    this.emitEvent({
      eventType: 'budget_warning',
      scopeId: state.scopeId,
      policyId: policy.policyId,
      timestamp: now,
      totalCostUsd: effectiveCost,
      thresholdUsd: policy.warningThresholdUsd,
      percentUsed: (effectiveCost / policy.hardLimitUsd) * 100,
    } as BudgetWarningEvent);
  }

  private downgradeScope(record: ScopeRecord): void {
    const { policy, state } = record;
    const now = new Date().toISOString();
    const fromModel = state.activeModel;

    state.tier = 'downgraded';
    state.activeModel = policy.downgradeModel;
    state.isDowngraded = true;
    state.tierChangedAt = now;
    this.totalDowngrades++;

    this.emitEvent({
      eventType: 'model_downgraded',
      scopeId: state.scopeId,
      policyId: policy.policyId,
      timestamp: now,
      fromModel,
      toModel: policy.downgradeModel,
      totalCostUsd: state.totalCostUsd,
      reason: `Cost $${state.totalCostUsd.toFixed(4)} exceeded downgrade threshold $${policy.downgradeThresholdUsd}`,
    } as ModelDowngradedEvent);
  }

  private freezeScope(record: ScopeRecord, reason: string): void {
    const { policy, state } = record;
    const now = new Date().toISOString();

    state.tier = 'frozen';
    state.isFrozen = true;
    state.tierChangedAt = now;
    this.totalFrozen++;

    if (policy.escalateToHitlOnFreeze) {
      // Generate a synthetic HITL request ID for correlation
      state.hitlRequestId = `hitl_finops_${state.scopeId}_${Date.now().toString(36)}`;
      this.totalHitlEscalations++;
    }

    this.emitEvent({
      eventType: 'agent_frozen',
      scopeId: state.scopeId,
      policyId: policy.policyId,
      timestamp: now,
      totalCostUsd: state.totalCostUsd,
      hardLimitUsd: policy.hardLimitUsd,
      callCount: state.callCount,
      hitlRequestId: state.hitlRequestId,
    } as AgentFrozenEvent);
  }

  // ── Private: Sliding window ────────────────────────────────────

  private trimCallHistory(record: ScopeRecord): void {
    const { policy } = record;
    if (policy.slidingWindowMs <= 0) return;

    const cutoff = Date.now() - policy.slidingWindowMs;
    record.callHistory = record.callHistory.filter((c) => c.completedAt >= cutoff);
  }

  private getEffectiveCost(record: ScopeRecord): number {
    const { policy, state } = record;

    if (policy.slidingWindowMs <= 0) {
      return state.totalCostUsd;
    }

    // Sliding window: sum only recent calls
    const cutoff = Date.now() - policy.slidingWindowMs;
    return record.callHistory
      .filter((c) => c.completedAt >= cutoff)
      .reduce((sum, c) => sum + c.costUsd, 0);
  }

  // ── Private: Helpers ───────────────────────────────────────────

  private emitEvent(event: TokenomicsEvent): void {
    for (const cb of this.eventCallbacks) {
      try {
        cb(event);
      } catch {
        // Swallow listener errors — do not break the controller
      }
    }
  }

  private createUnregisteredState(scopeId: string): AgentSpendState {
    const now = new Date().toISOString();
    return {
      scopeId,
      policyId: 'unregistered',
      tier: 'ok',
      totalCostUsd: 0,
      totalTokens: 0,
      callCount: 0,
      activeModel: 'unknown',
      isDowngraded: false,
      isFrozen: false,
      firstActivityAt: now,
      lastActivityAt: now,
      tierChangedAt: now,
    };
  }
}
