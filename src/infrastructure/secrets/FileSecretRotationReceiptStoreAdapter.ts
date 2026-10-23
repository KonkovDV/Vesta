import fs from 'node:fs/promises';
import path from 'node:path';

import { ConstraintViolationError } from '@/domain/errors/DomainError';
import type {
  ISecretRotationReceiptStore,
  SecretRotationReceipt,
} from '@/domain/security/secret-rotation-receipt-store.port';

interface SerializedSecretRotationReceipt {
  receiptId: string;
  planId: string;
  correlationId: string;
  requestedBy: string;
  targetIds: string[];
  dryRun: boolean;
  createdAt: string;
  status: SecretRotationReceipt['status'];
  execution: {
    planId: string;
    correlationId: string;
    status: SecretRotationReceipt['execution']['status'];
    failedStage?: SecretRotationReceipt['execution']['failedStage'];
    stageResults: SecretRotationReceipt['execution']['stageResults'];
    startedAt: string;
    finishedAt: string;
  };
}

export class FileSecretRotationReceiptStoreAdapter implements ISecretRotationReceiptStore {
  private writeChain = Promise.resolve();

  constructor(
    private readonly filePath: string = path.resolve(
      process.cwd(),
      'artifacts',
      'security',
      'secret-rotation-receipts.jsonl',
    ),
  ) {}

  async save(receipt: SecretRotationReceipt): Promise<void> {
    const nextWrite = this.writeChain.then(async () => {
      const receipts = await this.readAll();
      if (receipts.some((entry) => entry.receiptId === receipt.receiptId)) {
        throw new ConstraintViolationError(
          'receiptId',
          `Secret rotation receipt already exists: ${receipt.receiptId}`,
          {
            correlationId: receipt.correlationId,
            metadata: {
              receiptId: receipt.receiptId,
              planId: receipt.planId,
            },
          },
        );
      }

      await this.ensureStore();
      await fs.appendFile(this.filePath, `${JSON.stringify(this.serialize(receipt))}\n`, 'utf8');
    });

    this.writeChain = nextWrite.catch(() => undefined);
    await nextWrite;
  }

  async getById(receiptId: string): Promise<SecretRotationReceipt | undefined> {
    const receipts = await this.readAll();
    return receipts.find((receipt) => receipt.receiptId === receiptId);
  }

  async listRecent(limit = 20): Promise<readonly SecretRotationReceipt[]> {
    const receipts = await this.readAll();
    return receipts
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit);
  }

  private async ensureStore(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, '', 'utf8');
    }
  }

  private async readAll(): Promise<SecretRotationReceipt[]> {
    await this.ensureStore();

    const raw = await fs.readFile(this.filePath, 'utf8');
    if (!raw.trim()) {
      return [];
    }

    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => this.deserialize(JSON.parse(line) as SerializedSecretRotationReceipt));
  }

  private serialize(receipt: SecretRotationReceipt): SerializedSecretRotationReceipt {
    return {
      receiptId: receipt.receiptId,
      planId: receipt.planId,
      correlationId: receipt.correlationId,
      requestedBy: receipt.requestedBy,
      targetIds: [...receipt.targetIds],
      dryRun: receipt.dryRun,
      createdAt: receipt.createdAt.toISOString(),
      status: receipt.status,
      execution: {
        planId: receipt.execution.planId,
        correlationId: receipt.execution.correlationId,
        status: receipt.execution.status,
        failedStage: receipt.execution.failedStage,
        stageResults: [...receipt.execution.stageResults],
        startedAt: receipt.execution.startedAt.toISOString(),
        finishedAt: receipt.execution.finishedAt.toISOString(),
      },
    };
  }

  private deserialize(receipt: SerializedSecretRotationReceipt): SecretRotationReceipt {
    return {
      receiptId: receipt.receiptId,
      planId: receipt.planId,
      correlationId: receipt.correlationId,
      requestedBy: receipt.requestedBy,
      targetIds: receipt.targetIds,
      dryRun: receipt.dryRun,
      createdAt: new Date(receipt.createdAt),
      status: receipt.status,
      execution: {
        planId: receipt.execution.planId,
        correlationId: receipt.execution.correlationId,
        status: receipt.execution.status,
        failedStage: receipt.execution.failedStage,
        stageResults: receipt.execution.stageResults,
        startedAt: new Date(receipt.execution.startedAt),
        finishedAt: new Date(receipt.execution.finishedAt),
      },
    };
  }
}
