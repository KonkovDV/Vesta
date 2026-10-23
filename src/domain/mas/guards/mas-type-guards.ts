/**
 * Type guards for MAS domain types.
 * Replaces unsafe `as` assertions with runtime validation.
 * Layer: Domain
 */

import { MasTaskStatus } from '../MasTaskStatus';
import { MasExecutionStatus } from '../MasExecutionStatus';
import { MasExecutionStepKind } from '../MasExecutionStepKind';
import type { MasExecutionError } from '../MasExecutionError';
import type { MasErrorCategory } from '../services/mas-error-types';
import { isNonNullObject, isString } from '../../../core/guards/type-guards';

// Valid enum values for runtime validation
const VALID_TASK_STATUSES: readonly string[] = Object.values(MasTaskStatus);
const VALID_EXECUTION_STATUSES: readonly string[] = Object.values(MasExecutionStatus);
const VALID_STEP_KINDS: readonly string[] = Object.values(MasExecutionStepKind);

/**
 * Validates if value is a valid MasTaskStatus.
 */
export function isMasTaskStatus(value: unknown): value is MasTaskStatus {
  return isString(value) && VALID_TASK_STATUSES.includes(value);
}

/**
 * Validates and returns MasTaskStatus or defaults to Pending.
 */
export function validateMasTaskStatus(value: unknown): MasTaskStatus {
  return isMasTaskStatus(value) ? value : MasTaskStatus.Pending;
}

/**
 * Validates if value is a valid MasExecutionStatus.
 */
export function isMasExecutionStatus(value: unknown): value is MasExecutionStatus {
  return isString(value) && VALID_EXECUTION_STATUSES.includes(value);
}

/**
 * Validates and returns MasExecutionStatus or defaults to Planned.
 */
export function validateMasExecutionStatus(value: unknown): MasExecutionStatus {
  return isMasExecutionStatus(value) ? value : MasExecutionStatus.Planned;
}

/**
 * Validates if value is a valid MasExecutionStepKind.
 */
export function isMasExecutionStepKind(value: unknown): value is MasExecutionStepKind {
  return isString(value) && VALID_STEP_KINDS.includes(value);
}

/**
 * Validates and returns MasExecutionStepKind or defaults to SYSTEM.
 */
export function validateMasExecutionStepKind(value: unknown): MasExecutionStepKind {
  return isMasExecutionStepKind(value) ? value : MasExecutionStepKind.SYSTEM;
}

/**
 * Validates if value is a valid MasErrorCategory.
 */
export function isMasErrorCategory(value: unknown): value is MasErrorCategory {
  return isString(value) && ['decomposition', 'memory', 'policy', 'plugin', 'session_state', 'execution', 'unknown'].includes(value);
}

/**
 * Type guard for MasExecutionError.
 */
export function isMasExecutionError(value: unknown): value is MasExecutionError {
  if (!isNonNullObject(value)) {
    return false;
  }
  const obj = value;
  return (
    isString(obj.code) &&
    isString(obj.message) &&
    isNonNullObject(obj.details) &&
    obj.firstOccurredAt instanceof Date &&
    obj.lastOccurredAt instanceof Date
  );
}

/**
 * Safely casts database status string to MasTaskStatus.
 * Throws TypeError if invalid (fail-fast for data integrity issues).
 */
export function castToMasTaskStatus(value: unknown): MasTaskStatus {
  if (isMasTaskStatus(value)) {
    return value;
  }
  throw new TypeError(`Invalid MasTaskStatus: ${String(value)}`);
}

/**
 * Safely casts database status string to MasExecutionStatus.
 * Throws TypeError if invalid (fail-fast for data integrity issues).
 */
export function castToMasExecutionStatus(value: unknown): MasExecutionStatus {
  if (isMasExecutionStatus(value)) {
    return value;
  }
  throw new TypeError(`Invalid MasExecutionStatus: ${String(value)}`);
}

/**
 * Safely casts database kind string to MasExecutionStepKind.
 * Throws TypeError if invalid (fail-fast for data integrity issues).
 */
export function castToMasExecutionStepKind(value: unknown): MasExecutionStepKind {
  if (isMasExecutionStepKind(value)) {
    return value;
  }
  throw new TypeError(`Invalid MasExecutionStepKind: ${String(value)}`);
}

// ── TeamStatus guards ─────────────────────────────────────────────

export type TeamStatus = 'active' | 'suspended' | 'archived';

const VALID_TEAM_STATUSES: readonly string[] = ['active', 'suspended', 'archived'];

export function isTeamStatus(value: unknown): value is TeamStatus {
  return isString(value) && VALID_TEAM_STATUSES.includes(value);
}

export function validateTeamStatus(value: unknown): TeamStatus {
  return isTeamStatus(value) ? value : 'active';
}

export function castToTeamStatus(value: unknown): TeamStatus {
  if (isTeamStatus(value)) {
    return value;
  }
  throw new TypeError(`Invalid TeamStatus: ${String(value)}`);
}

// ── SwarmStatus guards ────────────────────────────────────────────

export type SwarmStatus = 'forming' | 'active' | 'dissolved';

const VALID_SWARM_STATUSES: readonly string[] = ['forming', 'active', 'dissolved'];

export function isSwarmStatus(value: unknown): value is SwarmStatus {
  return isString(value) && VALID_SWARM_STATUSES.includes(value);
}

export function validateSwarmStatus(value: unknown): SwarmStatus {
  return isSwarmStatus(value) ? value : 'forming';
}

export function castToSwarmStatus(value: unknown): SwarmStatus {
  if (isSwarmStatus(value)) {
    return value;
  }
  throw new TypeError(`Invalid SwarmStatus: ${String(value)}`);
}
