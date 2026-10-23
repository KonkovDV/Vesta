/**
 * IProfileMemory — Domain port for the durable profile memory plane.
 *
 * Governs identity-like and preference-like memory separately from generic
 * semantic recall. Infrastructure adapters may back this with PostgreSQL,
 * Mem0, or other long-term stores, but the plane semantics stay explicit:
 * scoped writes, replace-vs-merge supersession, and profile-only inspection.
 *
 * @layer Domain (Memory)
 * @since v2.9.0 — M1B-W2 profile plane contract extraction
 */

export const PROFILE_MEMORY_TYPES = ['user_profile', 'preference'] as const;

export type ProfileMemoryEntryType = typeof PROFILE_MEMORY_TYPES[number];

export interface ProfileMemoryEntry {
  readonly type: ProfileMemoryEntryType;
  readonly summary: string;
  readonly importance?: number;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
}

export type ProfileMemoryWriteMode = 'merge' | 'replace';

export interface WriteProfileMemoryInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly entries: ReadonlyArray<ProfileMemoryEntry>;
  readonly mode?: ProfileMemoryWriteMode;
  readonly correlationId?: string;
}

export interface SearchProfileMemoryInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly query: string;
  readonly limit?: number;
}

export interface ProfileMemorySnapshotInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly types?: ReadonlyArray<ProfileMemoryEntryType>;
  readonly limit?: number;
}

export interface ProfileMemoryWriteResult {
  readonly written: number;
  readonly superseded: number;
}

export interface IProfileMemory {
  writeProfileEntries(input: WriteProfileMemoryInput): Promise<ProfileMemoryWriteResult>;

  search(input: SearchProfileMemoryInput): Promise<ReadonlyArray<ProfileMemoryEntry>>;

  getProfileSnapshot(
    input: ProfileMemorySnapshotInput,
  ): Promise<ReadonlyArray<ProfileMemoryEntry>>;
}