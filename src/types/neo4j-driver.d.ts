/**
 * Type declarations for neo4j-driver.
 * 
 * This is a minimal type stub for optional neo4j-driver dependency.
 * If neo4j-driver is installed, its own types will take precedence.
 */

declare module 'neo4j-driver' {
  interface Auth {
    scheme: string;
    principal: string;
    credentials: string;
  }

  interface Driver {
    session(config?: { database?: string }): Session;
    close(): Promise<void>;
  }

  interface Session {
    run(query: string, params?: Record<string, unknown>): Promise<Result>;
    close(): Promise<void>;
  }

  interface Result {
    records: Record[];
    summary: ResultSummary;
  }

  interface Record {
    get(key: string): unknown;
    toObject(): Record<string, unknown>;
    keys: string[];
  }

  interface ResultSummary {
    counters: object;
  }

  interface Neo4j {
    driver(url: string, auth: Auth): Driver;
    auth: {
      basic(username: string, password: string): Auth;
    };
  }

  const neo4j: Neo4j;
  export default neo4j;
}
