/**
 * A2A x402 payment adapters.
 *
 * Layer: Infrastructure
 */

import type { ILogger } from '../../core/decorators/ILogger';
import type { ConfigLoader } from '../../config/ConfigLoader';
import type {
  A2AX402Asset,
  A2AX402Network,
  A2AX402PaymentPayload,
  A2AX402PaymentReceipt,
  A2AX402PaymentRecord,
  A2AX402PaymentRequirements,
  A2AX402SubmissionValidationResult,
  CreateA2AX402PaymentRequirementsInput,
  IA2AX402MerchantPolicy,
  IA2AX402NonceStore,
  IA2AX402PaymentRepository,
  IA2AX402SettlementPort,
} from '../../domain/a2a/a2a-x402-payment.interface';
import { SsrfDnsGuard } from '../security/SsrfDnsGuard';
import { pinnedExchange } from '../http/SsrfPinnedHttpClient';

const DEFAULT_TIMEOUT_SECONDS = 300;
const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 3_600;
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const BASE58_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

const SOLANA_MAINNET_USDC_PROFILE = {
  network: 'solana:mainnet',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as const;

const BASE_USDC_PROFILE = {
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as const;

type A2AX402MerchantProfile = {
  network: A2AX402Network;
  asset: A2AX402Asset;
};

export class ProfiledA2AX402MerchantPolicy implements IA2AX402MerchantPolicy {
  constructor(
    private readonly profiles: readonly A2AX402MerchantProfile[] = [
      SOLANA_MAINNET_USDC_PROFILE,
      BASE_USDC_PROFILE,
    ],
    private readonly defaultProfile: A2AX402MerchantProfile = SOLANA_MAINNET_USDC_PROFILE,
  ) {}

  async createRequirements(
    input: CreateA2AX402PaymentRequirementsInput,
  ): Promise<A2AX402PaymentRequirements> {
    this.assertPositiveInteger(input.amountAtomic, 'amountAtomic');

    const profile = this.selectProfile(input.network, input.asset);
    this.assertAddress(profile.network, input.payTo, 'payTo');
    const timeoutSeconds = this.normalizeTimeout(input.timeoutSeconds);

    return {
      version: 'x402-1',
      correlationId: input.correlationId,
      routes: [
        {
          scheme: 'exact',
          network: profile.network,
          asset: profile.asset,
          payTo: input.payTo,
          maxAmountAtomic: input.amountAtomic,
          timeoutSeconds,
          description: input.description,
          resource: input.resource,
        },
      ],
    };
  }

  async validateSubmission(
    requirements: A2AX402PaymentRequirements,
    payload: A2AX402PaymentPayload,
  ): Promise<A2AX402SubmissionValidationResult> {
    const route = requirements.routes.find((candidate) => {
      return candidate.scheme === payload.scheme &&
        candidate.network === payload.network &&
        candidate.asset === payload.asset &&
        candidate.payTo === payload.payTo;
    });

    if (!route) {
      return { valid: false, reason: 'submitted payment does not match merchant route' };
    }

    if (!POSITIVE_INTEGER_PATTERN.test(payload.amountAtomic)) {
      return { valid: false, reason: 'submitted payment amount must be a positive integer string' };
    }

    if (payload.amountAtomic !== route.maxAmountAtomic) {
      return { valid: false, reason: 'submitted payment amount does not match required exact amount' };
    }

    if (!this.isSupportedAsset(payload.network, payload.asset)) {
      return { valid: false, reason: 'submitted asset identifier is invalid for network' };
    }

    if (!this.isSupportedAddress(payload.network, payload.payer)) {
      return { valid: false, reason: 'submitted payer address is invalid' };
    }

    if (!this.isSupportedAddress(payload.network, payload.payTo)) {
      return { valid: false, reason: 'submitted payTo address is invalid' };
    }

    if (payload.signature.trim().length < 8) {
      return { valid: false, reason: 'submitted signature is too short' };
    }

    if (payload.nonce.trim().length < 8) {
      return { valid: false, reason: 'submitted nonce is too short' };
    }

    const validUntilMs = Date.parse(payload.validUntil);
    if (Number.isNaN(validUntilMs)) {
      return { valid: false, reason: 'submitted validUntil is not a valid ISO timestamp' };
    }

    if (validUntilMs <= Date.now()) {
      return { valid: false, reason: 'submitted payment is expired' };
    }

    return { valid: true };
  }

  private selectProfile(network?: A2AX402Network, asset?: A2AX402Asset): A2AX402MerchantProfile {
    if (!network && !asset) {
      return this.defaultProfile;
    }

    const profile = this.profiles.find((candidate) => {
      const networkMatches = !network || candidate.network === network;
      const assetMatches = !asset || this.isSameAsset(candidate.network, candidate.asset, asset);
      return networkMatches && assetMatches;
    });

    if (!profile) {
      throw new Error('requested x402 merchant profile is not supported');
    }

    return profile;
  }

  private normalizeTimeout(timeoutSeconds?: number): number {
    if (timeoutSeconds === undefined) {
      return DEFAULT_TIMEOUT_SECONDS;
    }

    if (!Number.isInteger(timeoutSeconds)) {
      throw new Error('timeoutSeconds must be an integer');
    }

    if (timeoutSeconds < MIN_TIMEOUT_SECONDS || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw new Error(
        `timeoutSeconds must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}`,
      );
    }

    return timeoutSeconds;
  }

  private assertAddress(network: A2AX402Network, value: string, field: string): void {
    if (!this.isSupportedAddress(network, value)) {
      throw new Error(`${field} is invalid for ${network}`);
    }
  }

  private assertPositiveInteger(value: string, field: string): void {
    if (!POSITIVE_INTEGER_PATTERN.test(value)) {
      throw new Error(`${field} must be a positive integer string`);
    }
  }

  private isSupportedAddress(network: A2AX402Network, value: string): boolean {
    if (network === 'solana:mainnet') {
      return BASE58_ADDRESS_PATTERN.test(value);
    }

    return EVM_ADDRESS_PATTERN.test(value);
  }

  private isSupportedAsset(network: A2AX402Network, value: string): boolean {
    if (network === 'solana:mainnet') {
      return value === SOLANA_MAINNET_USDC_PROFILE.asset;
    }

    return value.toLowerCase() === BASE_USDC_PROFILE.asset.toLowerCase();
  }

  private isSameAsset(network: A2AX402Network, left: string, right: string): boolean {
    if (network === 'eip155:8453') {
      return left.toLowerCase() === right.toLowerCase();
    }

    return left === right;
  }
}

export class BaseUsdcA2AX402MerchantPolicy extends ProfiledA2AX402MerchantPolicy {
  constructor() {
    super([BASE_USDC_PROFILE], BASE_USDC_PROFILE);
  }
}

export class InMemoryA2AX402PaymentRepository implements IA2AX402PaymentRepository {
  private readonly records = new Map<string, A2AX402PaymentRecord>();

  async save(record: A2AX402PaymentRecord): Promise<void> {
    this.records.set(record.taskId, { ...record });
  }

  async getByTaskId(taskId: string): Promise<A2AX402PaymentRecord | null> {
    return this.records.get(taskId) ?? null;
  }
}

export class InMemoryA2AX402NonceStore implements IA2AX402NonceStore {
  private readonly nonces = new Map<string, number>();

  async reserve(nonce: string, validUntil: string): Promise<boolean> {
    const expiry = Date.parse(validUntil);
    if (Number.isNaN(expiry) || expiry <= Date.now()) {
      return false;
    }

    const existing = this.nonces.get(nonce);
    if (existing && existing > Date.now()) {
      return false;
    }

    this.nonces.set(nonce, expiry);
    return true;
  }
}

export class HttpA2AX402SettlementAdapter implements IA2AX402SettlementPort {
  constructor(
    private readonly logger: ILogger,
    private readonly configLoader: ConfigLoader,
    private readonly ssrfGuard?: SsrfDnsGuard,
  ) {}

  async settle(
    taskId: string,
    requirements: A2AX402PaymentRequirements,
    payload: A2AX402PaymentPayload,
    correlationId?: string,
  ): Promise<A2AX402PaymentReceipt> {
    const facilitatorUrl = this.resolveFacilitatorUrl();
    if (!facilitatorUrl) {
      throw new Error('A2A_X402_FACILITATOR_URL is not configured');
    }

    this.logger.info('HttpA2AX402SettlementAdapter.settle', {
      taskId,
      correlationId,
      facilitatorUrl,
    });

    if (this.ssrfGuard) {
      const pinned = await pinnedExchange(this.ssrfGuard, {
        method: 'POST',
        url: facilitatorUrl,
        timeoutMs: 30_000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
        },
        body: JSON.stringify({
          taskId,
          requirements,
          payment: payload,
        }),
      });
      if (pinned.statusCode < 200 || pinned.statusCode >= 300) {
        throw new Error(`x402 facilitator responded ${pinned.statusCode}`);
      }
      return this.toReceipt(taskId, payload, JSON.parse(pinned.body) as unknown);
    }

    const response = await fetch(facilitatorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
      },
      body: JSON.stringify({
        taskId,
        requirements,
        payment: payload,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`x402 facilitator responded ${response.status} ${response.statusText}`);
    }

    const raw = await response.json() as unknown;
    return this.toReceipt(taskId, payload, raw);
  }

  private resolveFacilitatorUrl(): string | undefined {
    const config = this.configLoader.get() as unknown;
    return this.readNestedString(config, ['integrations', 'a2aX402', 'facilitatorUrl']) ??
      this.readNestedString(config, ['a2aX402', 'facilitatorUrl']);
  }

  private toReceipt(
    taskId: string,
    payload: A2AX402PaymentPayload,
    raw: unknown,
  ): A2AX402PaymentReceipt {
    const record = this.asRecord(raw);
    const settledAt = this.readString(record, 'settledAt') ?? new Date().toISOString();
    const status = this.readString(record, 'status') === 'rejected' || record.success === false
      ? 'rejected'
      : 'accepted';

    return {
      receiptId: this.readString(record, 'receiptId') ?? `x402:${taskId}:${payload.nonce}`,
      taskId,
      network: payload.network,
      asset: payload.asset,
      payer: payload.payer,
      payTo: payload.payTo,
      amountAtomic: payload.amountAtomic,
      status,
      settledAt,
      settlementReference: this.readString(record, 'settlementReference') ??
        this.readString(record, 'txHash') ??
        payload.txHash,
      failureReason: this.readString(record, 'failureReason'),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value as Record<string, unknown>;
  }

  private readNestedString(value: unknown, path: string[]): string | undefined {
    let current: unknown = value;
    for (const segment of path) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    return typeof current === 'string' && current.trim().length > 0 ? current : undefined;
  }

  private readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }
}