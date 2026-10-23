import { injectable, inject, optional } from 'inversify';
import type { ILogger } from '../../core/decorators/ILogger';
import { IdGenerator } from '../../core/utils/IdGenerator';
import type {
  ApprovalNotificationCallback,
  ApprovalRequestContext,
  ApprovalRequest,
  ApprovalResolveRequest,
  ApprovalStats,
  IUserApprovalInterceptor,
  PendingApprovalRecord,
} from '../../domain/security/IUserApprovalInterceptor';

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

@injectable()
export class UserApprovalInterceptorAdapter implements IUserApprovalInterceptor {
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly waiters = new Map<string, (approval: ApprovalRequest) => void>();
  private readonly approvalCallbacks: ApprovalNotificationCallback[] = [];
  private readonly resolutionTimesMs: number[] = [];

  constructor(
    @inject('ILogger') @optional() private readonly logger?: ILogger,
  ) {}

  async requestApproval(request: ApprovalRequestContext): Promise<ApprovalRequest> {
    const now = new Date();
    const expiresAt = request.expiresAt ?? new Date(now.getTime() + DEFAULT_APPROVAL_TTL_MS).toISOString();
    const requestId = IdGenerator.generateWithPrefix('approval');

    const record: ApprovalRequest = {
      ...request,
      id: requestId,
      requestId,
      action: request.action ?? request.toolName,
      toolName: request.toolName ?? request.action,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt,
    };

    this.approvals.set(record.id, record);
    this.logger?.info('mcp_approval_requested', {
      approvalId: record.id,
      toolName: record.toolName,
      correlationId: record.correlationId,
      scopeLevel: record.scopeLevel,
    });

    for (const callback of this.approvalCallbacks) {
      void callback(record).catch((error) => {
        this.logger?.warn('mcp_approval_callback_failed', {
          approvalId: record.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return record;
  }

  async getPendingApprovals(userId?: string): Promise<readonly PendingApprovalRecord[]> {
    this.expireStaleApprovals();
    return Array.from(this.approvals.values()).filter((record) => {
      if (record.status !== 'pending') return false;
      if (!userId) return true;
      return record.userId === userId;
    });
  }

  async getDecision(id: string): Promise<PendingApprovalRecord | null> {
    this.expireStaleApprovals();
    return this.approvals.get(id) ?? null;
  }

  async recordDecision(id: string, decision: 'approved' | 'denied', decidedBy: string): Promise<PendingApprovalRecord | null> {
    this.expireStaleApprovals();
    const existing = this.approvals.get(id);
    if (!existing) {
      return null;
    }

    const decidedAt = new Date().toISOString();
    const updated: ApprovalRequest = {
      ...existing,
      status: decision,
      decidedAt,
      decidedBy,
      resolvedAt: decidedAt,
      resolvedBy: decidedBy,
    };

    this.approvals.set(id, updated);
    this.resolutionTimesMs.push(Date.parse(decidedAt) - Date.parse(String(existing.createdAt)));
    this.logger?.info('mcp_approval_decided', {
      approvalId: id,
      decision,
      decidedBy,
      correlationId: existing.correlationId,
    });

    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter(updated);
      this.waiters.delete(id);
    }

    return updated;
  }

  getPendingRequests(): ApprovalRequest[] {
    this.expireStaleApprovals();
    return Array.from(this.approvals.values()).filter((record) => record.status === 'pending');
  }

  getRequest(requestId: string): ApprovalRequest | undefined {
    this.expireStaleApprovals();
    return this.approvals.get(requestId);
  }

  getHistory(limit = 50): ApprovalRequest[] {
    this.expireStaleApprovals();
    return Array.from(this.approvals.values())
      .filter((record) => record.status !== 'pending')
      .sort((left, right) => Date.parse(String(right.decidedAt ?? right.createdAt)) - Date.parse(String(left.decidedAt ?? left.createdAt)))
      .slice(0, limit);
  }

  getStats(): ApprovalStats {
    this.expireStaleApprovals();
    const approvals = Array.from(this.approvals.values());
    const averageResolutionTimeMs = this.resolutionTimesMs.length > 0
      ? Math.round(this.resolutionTimesMs.reduce((sum, value) => sum + value, 0) / this.resolutionTimesMs.length)
      : 0;

    return {
      totalRequests: approvals.length,
      pendingRequests: approvals.filter((record) => record.status === 'pending').length,
      approvedRequests: approvals.filter((record) => record.status === 'approved').length,
      deniedRequests: approvals.filter((record) => record.status === 'denied').length,
      timedOutRequests: approvals.filter((record) => record.status === 'expired').length,
      averageResolutionTimeMs,
    };
  }

  async resolve(params: ApprovalResolveRequest): Promise<ApprovalRequest | null> {
    const result = await this.recordDecision(params.requestId, params.decision, params.resolvedBy);
    return result ? this.approvals.get(params.requestId) ?? null : null;
  }

  async waitForResolution(requestId: string): Promise<ApprovalRequest> {
    this.expireStaleApprovals();
    const existing = this.approvals.get(requestId);
    if (!existing) {
      throw new Error(`Approval request not found: ${requestId}`);
    }

    if (existing.status !== 'pending') {
      return existing;
    }

    return new Promise<ApprovalRequest>((resolve) => {
      const expiresAt = existing.expiresAt ? Date.parse(String(existing.expiresAt)) : Date.now() + DEFAULT_APPROVAL_TTL_MS;
      const timeoutMs = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : DEFAULT_APPROVAL_TTL_MS;

      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        this.expireSpecificApproval(requestId);
        const updated = this.approvals.get(requestId);
        resolve(updated ?? {
          ...existing,
          status: 'expired',
          decidedAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
        });
      }, timeoutMs);

      this.waiters.set(requestId, (approval) => {
        clearTimeout(timer);
        resolve(approval);
      });
    });
  }

  onApprovalNeeded(callback: ApprovalNotificationCallback): void {
    this.approvalCallbacks.push(callback);
  }

  purgeExpired(): number {
    return this.expireStaleApprovals();
  }

  dispose(): void {
    for (const [requestId, resolve] of this.waiters.entries()) {
      const approval = this.approvals.get(requestId);
      if (approval) {
        resolve({
          ...approval,
          status: 'denied',
          decidedAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
        });
      }
    }
    this.waiters.clear();
    this.approvalCallbacks.length = 0;
    this.approvals.clear();
  }

  private expireStaleApprovals(): number {
    let expiredCount = 0;
    const now = Date.now();
    for (const [id, record] of this.approvals.entries()) {
      if (record.status !== 'pending') {
        continue;
      }

      const expiresAt = Date.parse(String(record.expiresAt ?? ''));
      if (!Number.isFinite(expiresAt) || expiresAt > now) {
        continue;
      }

      this.expireSpecificApproval(id, now);
      expiredCount += 1;
    }
    return expiredCount;
  }

  private expireSpecificApproval(requestId: string, now = Date.now()): void {
    const record = this.approvals.get(requestId);
    if (!record || record.status !== 'pending') {
      return;
    }

    const expiredAt = new Date(now).toISOString();
    const updated: ApprovalRequest = {
      ...record,
      status: 'expired',
      decidedAt: expiredAt,
      resolvedAt: expiredAt,
    };

    this.approvals.set(requestId, updated);

    const waiter = this.waiters.get(requestId);
    if (waiter) {
      waiter(updated);
      this.waiters.delete(requestId);
    }
  }
}