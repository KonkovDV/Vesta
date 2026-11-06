/**
 * x402 paid A2A execution. Loaded only when MODULE_X402_ENABLED is true,
 * so a deployment that does not pay for A2A does not import these modules.
 */
import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import {
  HttpA2AX402SettlementAdapter,
  InMemoryA2AX402NonceStore,
  InMemoryA2AX402PaymentRepository,
  ProfiledA2AX402MerchantPolicy,
} from '../../a2a/A2AX402PaymentAdapters';
import { InMemoryA2AX402CommerceMeter } from '../../a2a/A2AX402CommerceMeter';
import {
  RequireA2AX402PaymentService,
  SubmitA2AX402PaymentService,
} from '../../../application/services/a2a/A2AX402PaymentService';

export function registerA2AX402Services(): void {
  container.register(DI_TOKENS.IA2AX402MerchantPolicy, () => {
    return new ProfiledA2AX402MerchantPolicy();
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2AX402PaymentRepository, () => {
    return new InMemoryA2AX402PaymentRepository();
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2AX402NonceStore, () => {
    return new InMemoryA2AX402NonceStore();
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2AX402SettlementPort, (c) => {
    return new HttpA2AX402SettlementAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IConfigLoader),
      c.resolve(DI_TOKENS.ISsrfDnsGuard),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2AX402CommerceMeter, () => {
    return new InMemoryA2AX402CommerceMeter();
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.RequireA2AX402PaymentService, (c) => {
    return new RequireA2AX402PaymentService(
      c.resolve(DI_TOKENS.IA2AX402MerchantPolicy),
      c.resolve(DI_TOKENS.IA2AX402PaymentRepository),
      c.resolve(DI_TOKENS.IEventStore),
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IA2AX402CommerceMeter),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.SubmitA2AX402PaymentService, (c) => {
    return new SubmitA2AX402PaymentService(
      c.resolve(DI_TOKENS.IA2AX402PaymentRepository),
      c.resolve(DI_TOKENS.IA2AX402MerchantPolicy),
      c.resolve(DI_TOKENS.IA2AX402NonceStore),
      c.resolve(DI_TOKENS.IA2AX402SettlementPort),
      c.resolve(DI_TOKENS.IEventStore),
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IA2AX402CommerceMeter),
    );
  }, { lifecycle: 'singleton' });
}
