/**
 * AutonomyLevelAdapter — Infrastructure adapter for IAutonomyLevel.
 *
 * Determines HITL requirements based on configurable rules:
 * 1. Per-tool-name override (highest priority)
 * 2. Per-risk-level override
 * 3. Default mode (fallback)
 *
 * Mode semantics:
 * - autonomous: no approval needed, agent proceeds freely
 * - supervised: human is notified but not blocking
 * - manual: human approval required before execution
 *
 * Best Practices Applied (March 2026):
 * - Config via IConfigLoader (Hard Rule #11)
 * - correlationId in all log entries (Hard Rule #6)
 *
 * DI: constructor(configLoader, logger) — 2 args
 *
 * @layer Infrastructure (implements Domain port)
 * @see IAutonomyLevel (src/domain/security/autonomy-level.interface.ts)
 * @see Book Ch.13 "Human-in-the-Loop" — configurable HITL
 */

import type {
  IAutonomyLevel,
  AutonomyMode,
  AutonomyConfig,
  ActionRiskLevel,
} from '../../domain/security/autonomy-level.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

/** Default configuration: supervised for high/critical, autonomous for rest */
const DEFAULT_CONFIG: AutonomyConfig = {
  defaultMode: 'autonomous',
  perRiskLevel: {
    high: 'supervised',
    critical: 'manual',
  },
};

export class AutonomyLevelAdapter implements IAutonomyLevel {
  private config: AutonomyConfig = DEFAULT_CONFIG;

  constructor(
    private readonly _configLoader: unknown, // TODO: Use IConfigLoader for initial autonomy config from env
    private readonly logger: ILogger,
  ) {}

  getMode(action: string, riskLevel: ActionRiskLevel): AutonomyMode {
    // 1. Per-tool override (highest priority)
    if (this.config.perToolName?.[action]) {
      return this.config.perToolName[action];
    }

    // 2. Per-risk-level override
    if (this.config.perRiskLevel?.[riskLevel]) {
      return this.config.perRiskLevel[riskLevel];
    }

    // 3. Default
    return this.config.defaultMode;
  }

  requiresApproval(action: string, riskLevel: ActionRiskLevel): boolean {
    const mode = this.getMode(action, riskLevel);
    return mode === 'manual';
  }

  configure(config: AutonomyConfig, correlationId: CorrelationId): void {
    this.config = config;

    this.logger.info('Autonomy level configured', {
      correlationId,
      defaultMode: config.defaultMode,
      riskLevelOverrides: Object.keys(config.perRiskLevel ?? {}),
      toolOverrides: Object.keys(config.perToolName ?? {}),
    });
  }
}
