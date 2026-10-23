/**
 * Quota decision port. The rule table stays in the memory layer.
 * Layer: Domain
 */

import type {
  MemoryGovernanceDecision,
  MemoryGovernanceRequest,
} from './memory-governance.types';

export interface IMemoryGovernanceService {
  evaluateOperation(request: MemoryGovernanceRequest): Promise<MemoryGovernanceDecision>;
}
