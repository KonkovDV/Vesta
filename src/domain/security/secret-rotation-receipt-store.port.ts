/**
 * Secret Rotation Receipt Store Domain Port
 *
 * Persists immutable receipts for operator evidence and audit review.
 *
 * @layer Domain
 */

import type { SecretRotationExecutionResult } from './secret-rotation-executor.port';

export interface SecretRotationReceipt {
  readonly receiptId: string;
  readonly planId: string;
  readonly correlationId: string;
  readonly requestedBy: string;
  readonly targetIds: readonly string[];
  readonly dryRun: boolean;
  readonly createdAt: Date;
  readonly status: SecretRotationExecutionResult['status'];
  readonly execution: SecretRotationExecutionResult;
}

export interface ISecretRotationReceiptStore {
  save(receipt: SecretRotationReceipt): Promise<void>;
  getById(receiptId: string): Promise<SecretRotationReceipt | undefined>;
  listRecent(limit?: number): Promise<readonly SecretRotationReceipt[]>;
}