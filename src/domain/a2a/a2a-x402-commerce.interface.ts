/**
 * A2A x402 commerce metering contracts.
 *
 * Layer: Domain
 */

import type { A2AX402Asset, A2AX402Network, A2AX402PaymentStatus } from './a2a-x402-payment.interface';

export type A2AX402PricingModel = 'pay-per-use';
export type A2AX402PlanTier = 'sandbox' | 'pro' | 'enterprise';
export type A2AX402BillingUnit = 'request';
export type A2AX402BillableOn = 'payment-settled';
export type A2AX402CommerceLifecycle = A2AX402PaymentStatus;

export interface A2AX402CommercialContext {
  skuId: string;
  featureCode: string;
  pricingModel: A2AX402PricingModel;
  planTier: A2AX402PlanTier;
  unit: A2AX402BillingUnit;
  billableOn: A2AX402BillableOn;
}

export interface RecordA2AX402CommerceLifecycleInput {
  taskId: string;
  correlationId: string;
  lifecycle: A2AX402CommerceLifecycle;
  network: A2AX402Network;
  asset: A2AX402Asset;
  amountAtomic: string;
  tenantId?: string;
  resource?: string;
  agentUrl?: string;
  payer?: string;
  settlementReference?: string;
  reason?: string;
  commercialContext?: Partial<A2AX402CommercialContext>;
}

export interface A2AX402CommerceRecord {
  recordId: string;
  taskId: string;
  correlationId: string;
  lifecycle: A2AX402CommerceLifecycle;
  commercialContext: A2AX402CommercialContext;
  network: A2AX402Network;
  asset: A2AX402Asset;
  amountAtomic: string;
  tenantId?: string;
  resource?: string;
  agentUrl?: string;
  payer?: string;
  settlementReference?: string;
  reason?: string;
  billable: boolean;
  recordedAt: string;
}

export interface IA2AX402CommerceMeter {
  recordLifecycle(
    input: RecordA2AX402CommerceLifecycleInput,
  ): Promise<A2AX402CommerceRecord>;
}