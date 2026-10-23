/**
 * MAS session persistence port.
 * Layer: Domain
 */

import type { MasSessionId, MasSessionContext } from './mas-types';

export interface MasSessionState {
  sessionId: MasSessionId;
  session: Omit<MasSessionContext, 'requestContext'>;
  version: number;
  createdAt: string;
  updatedAt: string;
  status?: 'active' | 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface IMasSessionStore {
  getSession(sessionId: MasSessionId): Promise<MasSessionState | null>;
  saveSession(state: MasSessionState): Promise<void>;
  deleteSession(sessionId: MasSessionId): Promise<void>;
  listRunnableSessions(limit?: number): Promise<MasSessionId[]>;
  resetStuckSessions(maxDurationMs: number): Promise<number>;
}
