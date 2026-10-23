/**
 * Memory Governance audit port.
 *
 * Layer: Domain
 *
 * The logger and outbox implementation lives in infrastructure.
 */

import type {
  MemoryGovernanceDecision,
  MemoryGovernanceRequest,
  MemoryGovernanceScope,
} from './memory-governance.types';

/**
 * Port for emitting governance audit records.
 *
 * Implementations MUST avoid logging raw content or PII; only IDs and
 * machine-readable reason codes are allowed.
 */
export interface IMemoryGovernanceAuditSink {
  recordDecision(input: {
    request: MemoryGovernanceRequest;
    decision: MemoryGovernanceDecision;
    scope: MemoryGovernanceScope;
  }): Promise<void>;
}