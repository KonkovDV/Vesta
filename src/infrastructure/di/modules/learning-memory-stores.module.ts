import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { PostgresLessonStore } from '../../memory/stores/PostgresLessonStore';
import { PostgresSuccessLedgerStore } from '../../memory/stores/PostgresSuccessLedgerStore';
import { PostgresTipStore } from '../../memory/stores/PostgresTipStore';
import { PostgresTrajectoryStore } from '../../memory/stores/PostgresTrajectoryStore';

export function registerLearningMemoryStoresModule(): void {
  if (!container.isRegistered(DI_TOKENS.ITrajectoryStore)) {
    container.register(
      DI_TOKENS.ITrajectoryStore,
      () => new PostgresTrajectoryStore(
        container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection),
      ),
      { lifecycle: 'singleton', tags: ['memory', 'trajectory', 'store', 'postgres'] },
    );
  }

  if (!container.isRegistered(DI_TOKENS.ILessonStore)) {
    container.register(
      DI_TOKENS.ILessonStore,
      () => new PostgresLessonStore(
        container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection),
      ),
      { lifecycle: 'singleton', tags: ['memory', 'lesson', 'store', 'postgres'] },
    );
  }

  if (!container.isRegistered(DI_TOKENS.ISuccessLedgerStore)) {
    container.register(
      DI_TOKENS.ISuccessLedgerStore,
      () => new PostgresSuccessLedgerStore(
        container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection),
      ),
      { lifecycle: 'singleton', tags: ['memory', 'lesson', 'ledger', 'store', 'postgres'] },
    );
  }

  if (!container.isRegistered(DI_TOKENS.ITipStore)) {
    container.register(
      DI_TOKENS.ITipStore,
      () => new PostgresTipStore(
        container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection),
      ),
      { lifecycle: 'singleton', tags: ['memory', 'tip', 'store', 'postgres'] },
    );
  }
}