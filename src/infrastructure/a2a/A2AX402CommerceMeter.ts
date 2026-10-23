/**
 * In-memory A2A x402 commerce meter.
 *
 * Layer: Infrastructure
 */

import {
  type A2AX402CommerceRecord,
  type A2AX402CommercialContext,
  type IA2AX402CommerceMeter,
  type RecordA2AX402CommerceLifecycleInput,
} from '../../domain/a2a/a2a-x402-commerce.interface';
import { IdGenerator } from '../../core/utils/IdGenerator';

const DEFAULT_COMMERCIAL_CONTEXT: A2AX402CommercialContext = {
  skuId: 'mpx.agentic.paid-task.v1',
  featureCode: 'agentic_paid_task',
  pricingModel: 'pay-per-use',
  planTier: 'pro',
  unit: 'request',
  billableOn: 'payment-settled',
};

export class InMemoryA2AX402CommerceMeter implements IA2AX402CommerceMeter {
  async recordLifecycle(
    input: RecordA2AX402CommerceLifecycleInput,
  ): Promise<A2AX402CommerceRecord> {
    const commercialContext = this.resolveCommercialContext(input.commercialContext);

    return {
      recordId: IdGenerator.generateWithPrefix('a2a_x402_meter'),
      taskId: input.taskId,
      correlationId: input.correlationId,
      lifecycle: input.lifecycle,
      commercialContext,
      network: input.network,
      asset: input.asset,
      amountAtomic: input.amountAtomic,
      tenantId: input.tenantId,
      resource: input.resource,
      agentUrl: input.agentUrl,
      payer: input.payer,
      settlementReference: input.settlementReference,
      reason: input.reason,
      billable: input.lifecycle === commercialContext.billableOn,
      recordedAt: new Date().toISOString(),
    };
  }

  private resolveCommercialContext(
    commercialContext?: Partial<A2AX402CommercialContext>,
  ): A2AX402CommercialContext {
    return {
      ...DEFAULT_COMMERCIAL_CONTEXT,
      ...commercialContext,
    };
  }
}