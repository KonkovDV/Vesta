import type { McpScopeLevel } from '../mcp/IMcpScopeGuard';

// ── Shared scalars ─────────────────────────────────────────────────

export type ApprovalTimestamp = string | Date;
export type ApprovalRiskLevel = 'medium' | 'high' | 'critical';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'timeout' | 'auto_approved';
export type ApprovalDecision = 'approved' | 'denied' | 'pending' | 'expired';

// ── Value objects ──────────────────────────────────────────────────

export interface ApprovalCostEstimate {
  readonly tokens?: number;
  readonly computeTimeMs?: number;
  readonly apiCalls?: number;
  readonly monetaryCostUsd?: number;
}

export interface ApprovalRequestContext {
  readonly toolName?: string;
  readonly action?: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly correlationId?: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly scopeLevel?: McpScopeLevel;
  readonly expiresAt?: ApprovalTimestamp;
  readonly estimatedCost?: ApprovalCostEstimate;
  readonly riskLevel?: ApprovalRiskLevel;
}

export interface PendingApprovalRecord extends ApprovalRequestContext {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly createdAt: ApprovalTimestamp;
  readonly expiresAt?: ApprovalTimestamp;
  readonly decidedAt?: ApprovalTimestamp;
  readonly decidedBy?: string;
  readonly resolvedAt?: ApprovalTimestamp;
  readonly resolvedBy?: string;
  readonly note?: string;
  readonly approverNote?: string;
}

export interface ApprovalRequest extends PendingApprovalRecord {
  readonly requestId: string;
}

export interface ApprovalResolveRequest {
  readonly requestId: string;
  readonly decision: 'approved' | 'denied';
  readonly resolvedBy: string;
  readonly note?: string;
}

export interface ApprovalStats {
  readonly totalRequests: number;
  readonly pendingRequests: number;
  readonly approvedRequests: number;
  readonly deniedRequests: number;
  readonly timedOutRequests: number;
  readonly averageResolutionTimeMs: number;
}

export interface ApprovalThresholdConfig {
  readonly tokenCostThreshold: number;
  readonly monetaryCostThreshold: number;
  readonly alwaysRequireApproval: string[];
  readonly riskLevelsRequiringApproval: ApprovalRiskLevel[];
  readonly approvalTimeoutMs: number;
  readonly maxPendingRequests: number;
  readonly autoApproveInDev: boolean;
}

export type ApprovalNotificationCallback = (request: ApprovalRequest) => Promise<void>;

// ── Port ───────────────────────────────────────────────────────────

/**
 * IUserApprovalInterceptor — Domain port for Human-in-the-Loop (HITL) approval.
 *
 * Supports both the lightweight MCP approval flow and the richer policy-engine
 * workflow while keeping a single port contract for adapters/controllers.
 * Optional methods (marked with `?:`) are implemented by the full Horizon 1
 * adapter but may be absent from simpler adapters.
 */
export interface IUserApprovalInterceptor {
  requestApproval(request: ApprovalRequestContext): Promise<ApprovalRequest>;
  getPendingApprovals(userId?: string): Promise<readonly PendingApprovalRecord[]>;
  getDecision(id: string): Promise<PendingApprovalRecord | null>;
  recordDecision(id: string, decision: 'approved' | 'denied', decidedBy: string): Promise<PendingApprovalRecord | null>;
  waitForResolution(requestId: string): Promise<ApprovalRequest>;
  getRequest(requestId: string): ApprovalRequest | undefined;
  onApprovalNeeded(callback: ApprovalNotificationCallback): void;
  purgeExpired(): number;
  dispose(): void;

  getPendingRequests(): ApprovalRequest[];
  getHistory(limit?: number): ApprovalRequest[];
  getStats(): ApprovalStats;

  resolve(params: ApprovalResolveRequest): Promise<ApprovalRequest | null>;
}
