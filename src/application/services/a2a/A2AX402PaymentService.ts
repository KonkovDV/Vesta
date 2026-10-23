/**
 * A2A x402 payment services.
 *
 * Layer: Application
 */

import type { ILogger } from '../../../core/decorators/ILogger';
import type { IEventStore, DomainEvent } from '../../../domain/events/event-store.interface';
import { EventFactory } from '../../../domain/events/event-store.interface';
import type {
  A2AX402CommercialContext,
  A2AX402CommerceRecord,
  IA2AX402CommerceMeter,
} from '../../../domain/a2a/a2a-x402-commerce.interface';
import type {
  A2AX402Asset,
  A2AX402Network,
  A2AX402PaymentPayload,
  A2AX402PaymentReceipt,
  A2AX402PaymentRecord,
  IA2AX402MerchantPolicy,
  IA2AX402NonceStore,
  IA2AX402PaymentRepository,
  IA2AX402SettlementPort,
} from '../../../domain/a2a/a2a-x402-payment.interface';

export interface RequireA2AX402PaymentRequest {
  taskId: string;
  correlationId: string;
  amountAtomic: string;
  payTo: string;
  tenantId?: string;
  network?: A2AX402Network;
  asset?: A2AX402Asset;
  timeoutSeconds?: number;
  description?: string;
  resource?: string;
  agentUrl?: string;
  commercialContext?: Partial<A2AX402CommercialContext>;
  metadata?: Record<string, unknown>;
}

export interface SubmitA2AX402PaymentRequest {
  taskId: string;
  correlationId: string;
  payment: A2AX402PaymentPayload;
}

function toCommerceMeteredPayload(record: A2AX402CommerceRecord): Record<string, unknown> {
  return {
    recordId: record.recordId,
    taskId: record.taskId,
    correlationId: record.correlationId,
    lifecycle: record.lifecycle,
    skuId: record.commercialContext.skuId,
    featureCode: record.commercialContext.featureCode,
    pricingModel: record.commercialContext.pricingModel,
    planTier: record.commercialContext.planTier,
    unit: record.commercialContext.unit,
    billable: record.billable,
    network: record.network,
    asset: record.asset,
    amountAtomic: record.amountAtomic,
    tenantId: record.tenantId,
    resource: record.resource,
    agentUrl: record.agentUrl,
    payer: record.payer,
    settlementReference: record.settlementReference,
    reason: record.reason,
    recordedAt: record.recordedAt,
  };
}

export class RequireA2AX402PaymentService {
  constructor(
    private readonly merchantPolicy: IA2AX402MerchantPolicy,
    private readonly repository: IA2AX402PaymentRepository,
    private readonly eventStore?: IEventStore,
    private readonly logger?: ILogger,
    private readonly commerceMeter?: IA2AX402CommerceMeter,
  ) {}

  async requirePayment(
    request: RequireA2AX402PaymentRequest,
  ): Promise<A2AX402PaymentRecord> {
    const requirements = await this.merchantPolicy.createRequirements({
      amountAtomic: request.amountAtomic,
      payTo: request.payTo,
      correlationId: request.correlationId,
      network: request.network,
      asset: request.asset,
      timeoutSeconds: request.timeoutSeconds,
      description: request.description,
      resource: request.resource,
    });

    const now = new Date().toISOString();
    const record: A2AX402PaymentRecord = {
      taskId: request.taskId,
      agentUrl: request.agentUrl,
      correlationId: request.correlationId,
      status: 'payment-required',
      createdAt: now,
      updatedAt: now,
      requirements,
      metadata: request.metadata,
    };

    await this.repository.save(record);
    await this.emit(
      EventFactory.createBaseEvent(
        request.taskId,
        'agentic.a2a.x402.payment.required',
        {
          taskId: request.taskId,
          correlationId: request.correlationId,
          routes: [...requirements.routes],
        },
        request.correlationId,
      ),
    );

    const route = requirements.routes[0];
    if (this.commerceMeter && route) {
      const commerceRecord = await this.commerceMeter.recordLifecycle({
        taskId: request.taskId,
        correlationId: request.correlationId,
        lifecycle: 'payment-required',
        network: route.network,
        asset: route.asset,
        amountAtomic: request.amountAtomic,
        tenantId: request.tenantId,
        resource: request.resource,
        agentUrl: request.agentUrl,
        commercialContext: request.commercialContext,
      });
      await this.emitCommerceMetered(commerceRecord);
    }

    this.logger?.info('A2AX402PaymentService.requirePayment', {
      taskId: request.taskId,
      correlationId: request.correlationId,
      routes: requirements.routes.length,
    });

    return record;
  }

  private async emit(event: DomainEvent): Promise<void> {
    if (!this.eventStore) {
      return;
    }

    await this.eventStore.saveEvents([event]);
  }

  private async emitCommerceMetered(record: A2AX402CommerceRecord): Promise<void> {
    await this.emit(
      EventFactory.createBaseEvent(
        record.taskId,
        'agentic.a2a.x402.commerce.metered',
        toCommerceMeteredPayload(record),
        record.correlationId,
      ),
    );
  }
}

export class SubmitA2AX402PaymentService {
  constructor(
    private readonly repository: IA2AX402PaymentRepository,
    private readonly merchantPolicy: IA2AX402MerchantPolicy,
    private readonly nonceStore: IA2AX402NonceStore,
    private readonly settlementPort: IA2AX402SettlementPort,
    private readonly eventStore?: IEventStore,
    private readonly logger?: ILogger,
    private readonly commerceMeter?: IA2AX402CommerceMeter,
  ) {}

  async submitPayment(
    request: SubmitA2AX402PaymentRequest,
  ): Promise<A2AX402PaymentRecord> {
    const existing = await this.repository.getByTaskId(request.taskId);
    if (!existing) {
      throw new Error(`A2A x402 payment record not found for task ${request.taskId}`);
    }

    const validation = await this.merchantPolicy.validateSubmission(
      existing.requirements,
      request.payment,
    );
    if (!validation.valid) {
      return this.failRecord(existing, request, validation.reason ?? 'payment submission rejected');
    }

    const reserved = await this.nonceStore.reserve(
      request.payment.nonce,
      request.payment.validUntil,
    );
    if (!reserved) {
      return this.failRecord(existing, request, 'payment nonce already used or expired');
    }

    const submittedRecord: A2AX402PaymentRecord = {
      ...existing,
      status: 'payment-submitted',
      submittedPayment: request.payment,
      updatedAt: new Date().toISOString(),
      failureReason: undefined,
    };
    await this.repository.save(submittedRecord);
    await this.emit(
      EventFactory.createBaseEvent(
        request.taskId,
        'agentic.a2a.x402.payment.submitted',
        {
          taskId: request.taskId,
          correlationId: request.correlationId,
          payer: request.payment.payer,
          network: request.payment.network,
          asset: request.payment.asset,
          amountAtomic: request.payment.amountAtomic,
        },
        request.correlationId,
      ),
    );
    await this.recordCommerceLifecycle(submittedRecord, request, 'payment-submitted');

    try {
      const receipt = await this.settlementPort.settle(
        request.taskId,
        existing.requirements,
        request.payment,
        request.correlationId,
      );

      if (receipt.status === 'rejected') {
        return this.failRecord(
          submittedRecord,
          request,
          receipt.failureReason ?? 'payment rejected by settlement adapter',
          receipt,
        );
      }

      const settledRecord: A2AX402PaymentRecord = {
        ...submittedRecord,
        status: 'payment-settled',
        latestReceipt: receipt,
        updatedAt: new Date().toISOString(),
      };
      await this.repository.save(settledRecord);
      await this.emit(
        EventFactory.createBaseEvent(
          request.taskId,
          'agentic.a2a.x402.payment.settled',
          {
            taskId: request.taskId,
            correlationId: request.correlationId,
            receipt,
          },
          request.correlationId,
        ),
      );
      await this.recordCommerceLifecycle(settledRecord, request, 'payment-settled');

      this.logger?.info('A2AX402PaymentService.submitPayment.settled', {
        taskId: request.taskId,
        correlationId: request.correlationId,
        settlementReference: receipt.settlementReference,
      });

      return settledRecord;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.failRecord(submittedRecord, request, message);
    }
  }

  private async failRecord(
    existing: A2AX402PaymentRecord,
    request: SubmitA2AX402PaymentRequest,
    reason: string,
    receipt?: A2AX402PaymentReceipt,
  ): Promise<A2AX402PaymentRecord> {
    const failedRecord: A2AX402PaymentRecord = {
      ...existing,
      status: 'payment-failed',
      submittedPayment: request.payment,
      latestReceipt: receipt,
      failureReason: reason,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.save(failedRecord);
    await this.emit(
      EventFactory.createBaseEvent(
        request.taskId,
        'agentic.a2a.x402.payment.failed',
        {
          taskId: request.taskId,
          correlationId: request.correlationId,
          reason,
          network: request.payment.network,
          asset: request.payment.asset,
          payer: request.payment.payer,
        },
        request.correlationId,
      ),
    );
    await this.recordCommerceLifecycle(failedRecord, request, 'payment-failed');

    this.logger?.warn('A2AX402PaymentService.submitPayment.failed', {
      taskId: request.taskId,
      correlationId: request.correlationId,
      reason,
    });

    return failedRecord;
  }

  private async emit(event: DomainEvent): Promise<void> {
    if (!this.eventStore) {
      return;
    }

    await this.eventStore.saveEvents([event]);
  }

  private async recordCommerceLifecycle(
    record: A2AX402PaymentRecord,
    request: SubmitA2AX402PaymentRequest,
    lifecycle: 'payment-submitted' | 'payment-settled' | 'payment-failed',
  ): Promise<void> {
    if (!this.commerceMeter) {
      return;
    }

    const commerceRecord = await this.commerceMeter.recordLifecycle({
      taskId: record.taskId,
      correlationId: request.correlationId,
      lifecycle,
      network: request.payment.network,
      asset: request.payment.asset,
      amountAtomic: request.payment.amountAtomic,
      agentUrl: record.agentUrl,
      payer: request.payment.payer,
      resource: record.requirements.routes[0]?.resource,
      settlementReference: record.latestReceipt?.settlementReference,
      reason: record.failureReason,
    });
    await this.emitCommerceMetered(commerceRecord);
  }

  private async emitCommerceMetered(record: A2AX402CommerceRecord): Promise<void> {
    await this.emit(
      EventFactory.createBaseEvent(
        record.taskId,
        'agentic.a2a.x402.commerce.metered',
        toCommerceMeteredPayload(record),
        record.correlationId,
      ),
    );
  }
}