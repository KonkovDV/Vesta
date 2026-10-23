declare module 'sqlite-vec' {
    import { Database } from 'better-sqlite3';
    export function load(db: Database): void;
}

declare module 'better-sqlite3' {
    interface Database {
        prepare(sql: string): Statement;
        exec(sql: string): Database;
        transaction(fn: (...args: any[]) => any): (...args: any[]) => any;
        pragma(sql: string, options?: any): any;
        backup(destination: string, options?: any): Promise<any>;
        function(name: string, cb: (...args: any[]) => any): Database;
        aggregate(name: string, options: any): Database;
        loadExtension(path: string): Database;
        close(): void;
    }

    interface Statement {
        run(...args: any[]): RunResult;
        get(...args: any[]): any;
        all(...args: any[]): any[];
        iterate(...args: any[]): IterableIterator<any>;
        pluck(toggle?: boolean): Statement;
        expand(toggle?: boolean): Statement;
        raw(toggle?: boolean): Statement;
        columns(): ColumnDefinition[];
        bind(...args: any[]): Statement;
    }

    interface RunResult {
        changes: number;
        lastInsertRowid: number | bigint;
    }

    interface ColumnDefinition {
        name: string;
        column: string;
        table: string;
        database: string;
        type: string;
    }

    interface Options {
        readonly?: boolean;
        fileMustExist?: boolean;
        timeout?: number;
        verbose?: (message?: any, ...additionalArgs: any[]) => void;
        nativeBinding?: string;
    }

    interface DatabaseConstructor {
        new (filename: string, options?: Options): Database;
        (filename: string, options?: Options): Database;
    }

    const Database: DatabaseConstructor;
    export = Database;
}
