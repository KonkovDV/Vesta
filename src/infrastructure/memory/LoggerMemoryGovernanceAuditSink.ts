/**
 * Logger and outbox audit sink for memory governance.
 * The composition root supplies the journal writer. This class does not reach into it.
 * Layer: Infrastructure
 */
import { logger } from '../logging/logger';
import type { IMemoryGovernanceAuditSink } from '../../domain/memory/governance/memory-governance.audit';
import type {
  MemoryGovernanceDecision,
  MemoryGovernanceRequest,
  MemoryGovernanceScope,
} from '../../domain/memory/governance/memory-governance.types';

const log = logger.child({ component: 'MemoryGovernanceAudit' });

export type GovernanceAuditEmitter = (input: {
  request: MemoryGovernanceRequest;
  decision: MemoryGovernanceDecision;
  scope: MemoryGovernanceScope;
}) => Promise<void>;

export class LoggerMemoryGovernanceAuditSink implements IMemoryGovernanceAuditSink {
  constructor(private readonly emitAuditEvents?: GovernanceAuditEmitter) {}

  async recordDecision(input: Parameters<IMemoryGovernanceAuditSink['recordDecision']>[0]): Promise<void> {
    const { request, decision, scope } = input;

    try {
      log.info('memory.governance.decision', decisionRecord(request, decision));
    } catch (err) {
      log.warn('Failed to emit logger-based memory governance audit record', {
        err,
        tenant_id: request.tenant_id,
        operation: request.operation,
      });
    }

    if (!this.emitAuditEvents) return;

    try {
      await this.emitAuditEvents({ request, decision, scope });
    } catch (err) {
      log.warn('Failed to emit memory governance typed events', {
        err,
        tenant_id: request.tenant_id,
        operation: request.operation,
      });
    }
  }
}

function decisionRecord(request: MemoryGovernanceRequest, decision: MemoryGovernanceDecision) {
  return {
    tenant_id: request.tenant_id,
    user_id: request.user_id,
    session_id: request.session_id,
    operation: request.operation,
    status: decision.status,
    reasons: decision.reasons,
    quota_status: decision.quota_status,
    quota_views: decision.quota_views,
    violations: decision.violations,
    correlation_id: request.correlation_id,
  };
}
