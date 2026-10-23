declare module 'bonjour-service' {
    export interface ServiceOptions {
        name: string;
        type: string;
        port: number;
        host?: string;
        txt?: Record<string, string>;
    }

    export interface Service {
        name: string;
        type: string;
        subtypes: string[];
        protocol: string;
        host: string;
        port: number;
        fqdn: string;
        txt: any;
        published: boolean;
        referer: any;
        stop(callback?: (err?: Error) => void): void;
        start(): void;
    }

    export interface Browser {
        on(event: 'up' | 'down', listener: (service: Service) => void): this;
        start(): void;
        stop(): void;
        update(): void;
    }

    export class Bonjour {
        constructor(opts?: any);
        publish(options: ServiceOptions): Service;
        unpublishAll(callback?: () => void): void;
        find(options: { type: string }, onUp?: (service: Service) => void): Browser;
        findOne(options: { type: string }, callback?: (service: Service) => void): Browser;
        destroy(): void;
    }
}
