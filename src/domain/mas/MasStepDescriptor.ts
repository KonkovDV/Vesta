/**
 * MasStepDescriptor - Domain type for MAS step descriptors.
 *
 * Layer: Domain (enterprise business rules)
 */

import type { MasMemoryPolicy } from './MasMemoryPolicy';
import type { MasExecutionStepKind } from './MasExecutionStepKind';

export interface MasStepDescriptor {
  kind: MasExecutionStepKind;
  idempotencyKey: string;
  inputSnapshot: Record<string, unknown>;
  maxAttempts?: number;
  memoryPolicy?: MasMemoryPolicy;
}
