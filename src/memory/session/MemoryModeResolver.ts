/**
 * Memory mode resolution for DualWriteMemoryManager (Phase 11 M1.5).
 *
 * Layer: Memory
 *
 * Источник правды по режимам описан в
 * - dual-write архитектуре: ../03-IMPLEMENTATION/phase-11-memory-details/dual-write-architecture.md
 * - Execution-плане Phase 11.
 */

import type { TenantId } from '../../domain/memory/session-types';
import { getRawEnv } from '../../config';

export type MemoryMode = 'legacy-only' | 'dual-write' | 'openmemory-only';

/**
 * Resolves current memory mode for a given tenant/environment.
 *
 * Для M1.5 реализация может быть глобальной (режим общий для всех tenants),
 * но интерфейс оставляет tenant_id для последующего per-tenant rollout.
 */
export interface MemoryModeResolver {
  getMode(tenantId: TenantId): MemoryMode;
}

/**
 * Env-based implementation of MemoryModeResolver.
 *
 * Приоритет источников:
 * 1. MEMORY_MODE
 * 2. APP_MEMORY_MODE
 * 3. NODE_ENV:
 *    - production  -> 'legacy-only'
 *    - иначе       -> 'dual-write'
 */
export class EnvMemoryModeResolver implements MemoryModeResolver {
  private readonly mode: MemoryMode;

  constructor(env: NodeJS.ProcessEnv = getRawEnv()) {
    this.mode = EnvMemoryModeResolver.resolveModeFromEnv(env);
  }

  getMode(_tenantId: TenantId): MemoryMode {
    return this.mode;
  }

  private static resolveModeFromEnv(env: NodeJS.ProcessEnv): MemoryMode {
    const raw = (env.MEMORY_MODE || env.APP_MEMORY_MODE || '').trim().toLowerCase();

    if (raw === 'legacy-only' || raw === 'legacy') {
      return 'legacy-only';
    }
    if (raw === 'dual-write' || raw === 'dual') {
      return 'dual-write';
    }
    if (raw === 'openmemory-only' || raw === 'openmemory') {
      return 'openmemory-only';
    }

    const nodeEnv = (env.NODE_ENV || 'development').toLowerCase();
    if (nodeEnv === 'production') {
      return 'legacy-only';
    }

    // В dev/test по умолчанию используем dual-write, чтобы прогонять оба пути.
    return 'dual-write';
  }
}