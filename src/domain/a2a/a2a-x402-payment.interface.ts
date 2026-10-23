/**
 * A2A x402 payment contracts.
 *
 * Layer: Domain
 *
 * Merchant-first foundation for paid A2A task execution across supported x402 networks.
 * This slice models payment requirements, submission, settlement, and persistence
 * without coupling the Domain layer to any transport or chain-specific SDK.
 */

export type A2AX402ProtocolVersion = 'x402-1';
export type A2AX402Network = 'solana:mainnet' | 'eip155:8453';
export type A2AX402Asset =
  | 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  | '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export type A2AX402PaymentScheme = 'exact';

export type A2AX402PaymentStatus =
  | 'payment-required'
  | 'payment-submitted'
  | 'payment-settled'
  | 'payment-failed';

export type A2AX402ReceiptStatus = 'accepted' | 'rejected';

export interface A2AX402PaymentRoute {
  scheme: A2AX402PaymentScheme;
  network: A2AX402Network;
  asset: A2AX402Asset;
  payTo: string;
  maxAmountAtomic: string;
  timeoutSeconds: number;
  description?: string;
  resource?: string;
}

export interface A2AX402PaymentRequirements {
  version: A2AX402ProtocolVersion;
  routes: readonly A2AX402PaymentRoute[];
  correlationId: string;
}

export interface A2AX402PaymentPayload {
  version: A2AX402ProtocolVersion;
  scheme: A2AX402PaymentScheme;
  network: A2AX402Network;
  asset: A2AX402Asset;
  amountAtomic: string;
  payTo: string;
  payer: string;
  nonce: string;
  signature: string;
  validUntil: string;
  txHash?: string;
}

export interface A2AX402PaymentReceipt {
  receiptId: string;
  taskId: string;
  network: A2AX402Network;
  asset: A2AX402Asset;
  payer: string;
  payTo: string;
  amountAtomic: string;
  status: A2AX402ReceiptStatus;
  settledAt: string;
  settlementReference?: string;
  failureReason?: string;
}

export interface A2AX402PaymentRecord {
  taskId: string;
  agentUrl?: string;
  correlationId: string;
  status: A2AX402PaymentStatus;
  createdAt: string;
  updatedAt: string;
  requirements: A2AX402PaymentRequirements;
  submittedPayment?: A2AX402PaymentPayload;
  latestReceipt?: A2AX402PaymentReceipt;
  failureReason?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateA2AX402PaymentRequirementsInput {
  amountAtomic: string;
  payTo: string;
  correlationId: string;
  network?: A2AX402Network;
  asset?: A2AX402Asset;
  timeoutSeconds?: number;
  description?: string;
  resource?: string;
}

export interface A2AX402SubmissionValidationResult {
  valid: boolean;
  reason?: string;
}

export interface IA2AX402MerchantPolicy {
  createRequirements(
    input: CreateA2AX402PaymentRequirementsInput,
  ): Promise<A2AX402PaymentRequirements>;

  validateSubmission(
    requirements: A2AX402PaymentRequirements,
    payload: A2AX402PaymentPayload,
  ): Promise<A2AX402SubmissionValidationResult>;
}

export interface IA2AX402PaymentRepository {
  save(record: A2AX402PaymentRecord): Promise<void>;
  getByTaskId(taskId: string): Promise<A2AX402PaymentRecord | null>;
}

export interface IA2AX402NonceStore {
  reserve(nonce: string, validUntil: string): Promise<boolean>;
}

export interface IA2AX402SettlementPort {
  settle(
    taskId: string,
    requirements: A2AX402PaymentRequirements,
    payload: A2AX402PaymentPayload,
    correlationId?: string,
  ): Promise<A2AX402PaymentReceipt>;
}

export type { IA2AX402CommerceMeter } from './a2a-x402-commerce.interface';