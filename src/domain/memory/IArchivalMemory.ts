/**
 * IArchivalMemory — Domain port for the cold archival memory plane.
 *
 * Exposes Tier 3 semantic retrieval and explicit availability inspection
 * independent of S-MMU paging. Infrastructure adapters may back this port
 * with pgvector, mem0, or other long-term semantic stores.
 *
 * Resolution via DI:
 *   container.resolve<IArchivalMemory>(DI_TOKENS.IArchivalMemory)
 *
 * @layer Domain (Memory)
 * @since v2.9.0 — M1B-W3 archival plane contract extraction
 */

export interface ArchivalMemorySearchResult {
  readonly content: string;
  readonly source: string;
  readonly score: number;
  readonly tokens: number;
  readonly updatedAt: string;
}

export interface ArchivalMemoryStatus {
  readonly available: boolean;
  readonly itemCount: number;
}

export interface IArchivalMemory {
  search(
    query: string,
    maxResults: number,
    tenantId?: string,
  ): Promise<ReadonlyArray<ArchivalMemorySearchResult>>;

  getItemCount(): Promise<number>;

  getStatus(): Promise<ArchivalMemoryStatus>;
}