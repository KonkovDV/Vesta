/**
 * Type stub for mem0ai SDK (platform mode).
 *
 * The actual `mem0ai` package is loaded lazily at runtime via dynamic import.
 * This stub provides minimal type declarations for TypeScript compilation.
 */

declare module 'mem0ai' {
  interface MemoryClientConfig {
    apiKey: string;
    org_id?: string;
    project_id?: string;
    [key: string]: unknown;
  }

  class MemoryClient {
    constructor(config: MemoryClientConfig);
    add(
      messages: Array<{ role: string; content: string }>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    search(
      query: string,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    get(memoryId: string): Promise<unknown>;
    getAll(options?: Record<string, unknown>): Promise<unknown>;
    delete(memoryId: string): Promise<unknown>;
  }

  export default MemoryClient;
}

declare module 'mem0ai/oss' {
  interface MemoryConfig {
    version?: string;
    embedder?: { provider: string; config: Record<string, unknown> };
    vector_store?: { provider: string; config: Record<string, unknown> };
    llm?: { provider: string; config: Record<string, unknown> };
    history_db_path?: string;
    custom_prompt?: string;
    [key: string]: unknown;
  }

  export class Memory {
    constructor(config?: MemoryConfig);
    add(
      messages: Array<{ role: string; content: string }>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    search(
      query: string,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
    get(memoryId: string): Promise<unknown>;
    getAll(options?: Record<string, unknown>): Promise<unknown>;
    delete(memoryId: string): Promise<unknown>;
  }
}
