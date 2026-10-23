declare module 'pg-cursor' {
  import type { QueryConfig, Submittable } from 'pg';

  class Cursor<Row = Record<string, unknown>> implements Submittable {
    constructor(text: string, values?: unknown[], config?: QueryConfig);
    read(rowCount: number): Promise<Row[]>;
    close(): Promise<void>;
    submit(connection: unknown): void;
  }

  export = Cursor;
}
