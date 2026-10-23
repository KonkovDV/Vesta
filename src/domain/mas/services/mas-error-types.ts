/**
 * mas-error-types - Core types for MAS error classification.
 *
 * Layer: Domain (enterprise business rules)
 */

export type MasErrorCategory =
  | 'decomposition'
  | 'execution'
  | 'memory'
  | 'policy'
  | 'plugin'
  | 'session_state'
  | 'unknown';
