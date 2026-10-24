/**
 * MAS session store. The contract lives in the domain.
 * Layer: Application
 */

export type { IMasSessionStore, MasSessionState } from '../../../domain/mas/mas-session-store';

export const masSessionStoreToken = 'IMasSessionStore' as const;
