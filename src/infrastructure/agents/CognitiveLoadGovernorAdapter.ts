/**
 * CognitiveLoadGovernorAdapter — In-memory proactivity throttling via cognitive load monitoring.
 *
 * In-memory implementation of ICognitiveLoadGovernor. Tracks agent actions by type
 * and PROBE phase, applies intent-based decay, and emits throttle signals when
 * cumulative load exceeds phase budgets.
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-025 Cognitive Load Governor (PUA v5.1 → codified)
 * @see src/domain/agents/ICognitiveLoadGovernor.ts — domain port
 * @see src/core/events/cognitive-load-governor.schemas.ts — Zod validation schemas
 */

import type {
  ICognitiveLoadGovernor,
  AgentActionType,
  ProbePhase,
  CognitiveLoadEntry,
  ThrottleSignal,
  CognitiveLoadConfig,
  CognitiveLoadStats,
} from '../../domain/agents/ICognitiveLoadGovernor';
import { DEFAULT_COGNITIVE_LOAD_CONFIG } from '../../domain/agents/ICognitiveLoadGovernor';

// ── Minimal Logger ────────────────────────────────────────────────

interface GovernorLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Phase Budget Mapping ──────────────────────────────────────────

function getPhaseBudget(phase: ProbePhase, config: CognitiveLoadConfig): number {
  switch (phase) {
    case 'search': return config.searchBudget;
    case 'identify': return config.identifyBudget;
    case 'resolve': return config.resolveBudget;
  }
}

// ── Action Type → Default Weight ──────────────────────────────────

const ACTION_WEIGHTS: Record<AgentActionType, number> = {
  search: 0.1,
  read: 0.05,
  edit: 0.3,
  verify: 0.2,
  propose: 0.15,
  delegate: 0.25,
  communicate: 0.05,
};

// ── Adapter ───────────────────────────────────────────────────────

export class CognitiveLoadGovernorAdapter implements ICognitiveLoadGovernor {
  private readonly entries: CognitiveLoadEntry[] = [];
  private currentPhase: ProbePhase = 'search';
  private deflections = 0;
  private misses = 0;
  private throttleEmitCount = 0;

  constructor(private readonly logger?: GovernorLogger) {}

  recordAction(entry: CognitiveLoadEntry): void {
    this.entries.push(entry);

    this.logger?.info('Cognitive load entry recorded', {
      actionType: entry.actionType,
      phase: entry.probePhase,
      weight: entry.weight,
      intentAligned: entry.intentAligned,
      totalEntries: this.entries.length,
    });
  }

  checkThrottle(config: CognitiveLoadConfig = DEFAULT_COGNITIVE_LOAD_CONFIG): ThrottleSignal {
    const phaseEntries = this.entries.filter(e => e.probePhase === this.currentPhase);
    const phaseLimit = getPhaseBudget(this.currentPhase, config);

    // Calculate decayed load for the current phase
    let currentLoad = 0;
    for (const entry of phaseEntries) {
      const decay = entry.intentAligned
        ? config.intentAlignedDecay
        : config.misalignedDecay;
      currentLoad += entry.weight * decay;
    }

    const ratio = phaseLimit > 0 ? currentLoad / phaseLimit : 0;
    const recommendation = this.calculateRecommendation(ratio);
    const active = recommendation !== 'continue';

    if (active) {
      this.throttleEmitCount++;
      this.logger?.warn('Throttle signal emitted', {
        phase: this.currentPhase,
        currentLoad,
        phaseLimit,
        recommendation,
      });
    }

    return {
      active,
      currentLoad,
      phaseLimit,
      currentPhase: this.currentPhase,
      recommendation,
      reason: active
        ? `Load ${currentLoad.toFixed(3)} exceeds threshold for phase "${this.currentPhase}" (limit: ${phaseLimit})`
        : `Load ${currentLoad.toFixed(3)} within budget for phase "${this.currentPhase}"`,
    };
  }

  enterPhase(phase: ProbePhase): void {
    this.currentPhase = phase;
    this.logger?.info('Entered PROBE phase', { phase });
  }

  recordDeflection(): void {
    this.deflections++;
    this.logger?.info('Bottleneck deflection recorded', { total: this.deflections });
  }

  recordMiss(): void {
    this.misses++;
  }

  getStats(): CognitiveLoadStats {
    const loadByPhase: Record<ProbePhase, number> = { search: 0, identify: 0, resolve: 0 };
    const loadByActionType: Record<AgentActionType, number> = {
      search: 0, read: 0, edit: 0, verify: 0, propose: 0, delegate: 0, communicate: 0,
    };

    for (const entry of this.entries) {
      loadByPhase[entry.probePhase] += entry.weight;
      loadByActionType[entry.actionType] += entry.weight;
    }

    const totalAttempts = this.deflections + this.misses;
    const bottleneckDeflectionRate = totalAttempts > 0
      ? this.deflections / totalAttempts
      : 0;

    return {
      totalLoad: this.entries.reduce((sum, e) => sum + e.weight, 0),
      loadByPhase,
      loadByActionType,
      actionCount: this.entries.length,
      throttleCount: this.throttleEmitCount,
      bottleneckDeflectionRate,
    };
  }

  reset(): void {
    this.entries.length = 0;
    this.currentPhase = 'search';
    this.deflections = 0;
    this.misses = 0;
    this.throttleEmitCount = 0;
    this.logger?.info('Cognitive Load Governor reset');
  }

  // ── Private Helpers ─────────────────────────────────────────

  private calculateRecommendation(ratio: number): ThrottleSignal['recommendation'] {
    if (ratio < 0.7) return 'continue';
    if (ratio < 0.85) return 'slow_down';
    if (ratio < 1.0) return 'pause';
    return 'escalate';
  }
}

/**
 * Default action weight for a given action type.
 * Exported for testing convenience.
 */
export { ACTION_WEIGHTS };
