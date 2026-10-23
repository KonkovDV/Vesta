declare module '@slack/bolt' {
    export class App {
        constructor(config: any);
        client: any;
        message(callback: (args: { message: any; say: any }) => Promise<void>): void;
        error(callback: (error: Error) => Promise<void>): void;
        start(): Promise<void>;
        stop(): Promise<void>;
    }
}
