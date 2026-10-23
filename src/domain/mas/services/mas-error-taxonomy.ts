/**
 * mas-error-taxonomy - Domain utilities for MAS error classification.
 *
 * Layer: Domain (enterprise business rules)
 */

import type { MasExecutionError } from '../MasExecutionError';
import type { MasErrorCategory } from './mas-error-types';

export function mapExecutionErrorToCategory(error: MasExecutionError): MasErrorCategory {
  // Map error codes to categories based on durable execution taxonomy
  const code = error.code;

  if (code.startsWith('DECOMPOSITION')) {
    return 'decomposition';
  }
  if (code.startsWith('MEMORY') || code.includes('MEMORY') || code.startsWith('MAS_MEMORY')) {
    return 'memory';
  }
  if (code.startsWith('POLICY') || code.includes('POLICY') || code.startsWith('MAS_POLICY')) {
    return 'policy';
  }
  if (code.startsWith('PLUGIN') || code.includes('PLUGIN') || code.startsWith('MAS_PLUGIN')) {
    return 'plugin';
  }
  if (code === 'CIRCUIT_OPEN' || code.startsWith('SESSION') || code.startsWith('CB_')) {
    return 'session_state';
  }
  if (code.startsWith('EXECUTION') || code.startsWith('STEP_') || code.startsWith('TASK_') || code.startsWith('MAX_')) {
    return 'execution';
  }

  return 'unknown';
}

export function isTransientDurableError(error: MasExecutionError): boolean {
  const code = error.code;
  if (code === 'STEP_TIMEOUT' || code === 'TASK_TIMEOUT' || code === 'CIRCUIT_OPEN') {
    return true;
  }
  return false;
}
