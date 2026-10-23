/**
 * Ebbinghaus 2.0 Temporal Decay DI Module.
 *
 * Registers ITemporalDecayStrategy adapter for memory decay calculations.
 *
 * @module infrastructure/di/modules
 * @phase Ebbinghaus 2.0
 */

import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { EbbinghausDecayAdapter } from '../../memory/temporal/EbbinghausDecayAdapter';

export function registerTemporalDecayModule(): void {
  if (container.isRegistered(DI_TOKENS.ITemporalDecayStrategy)) return;

  container.register(
    DI_TOKENS.ITemporalDecayStrategy,
    () => new EbbinghausDecayAdapter(),
    { lifecycle: 'singleton', tags: ['memory', 'decay', 'ebbinghaus'] },
  );
}
