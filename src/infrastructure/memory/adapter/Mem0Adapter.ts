import { injectable, inject } from 'inversify';
import { DI_TOKENS } from '../../../ai-types';
import type { IHttpClient, HttpClientRequestOptions } from '../../http/HttpClient';
import { ConfigLoader } from '../../../config/ConfigLoader';
import type { ILogger } from '../../../core/decorators/ILogger';
import { 
    SessionMessage, 
    TenantId, 
    UserId, 
    SessionId 
} from '../../../domain/memory/session-types';

export interface DistilledFact {
    id: string;
    text: string;
    event: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';
    old_memory?: string;
    metadata?: Record<string, unknown>;
}

interface Mem0Config {
    infrastructure?: {
        mem0?: {
            url?: string;
            apiKey?: string;
        };
    };
}

interface Mem0MemoryResponseRow {
    id?: string;
    memory?: string;
    event?: DistilledFact['event'];
    old_memory?: string;
    metadata?: Record<string, unknown>;
    score?: number;
}

interface Mem0AddMemoriesResponse {
    results?: Mem0MemoryResponseRow[];
}

export interface IMemoryDistiller {
    addMemories(input: {
        tenant_id: TenantId;
        user_id: UserId;
        session_id: SessionId;
        messages: SessionMessage[];
    }): Promise<DistilledFact[]>;
    
    searchFacts(input: {
        tenant_id: TenantId;
        user_id: UserId;
        query: string;
        limit?: number;
    }): Promise<DistilledFact[]>;
}

@injectable()
export class Mem0Adapter implements IMemoryDistiller {
    private readonly baseUrl: string;
    private readonly apiKey: string;

    constructor(
        @inject(DI_TOKENS.HttpClient) private readonly httpClient: IHttpClient,
        @inject('ConfigLoader') private readonly configLoader: ConfigLoader,
        @inject('ILogger') private readonly logger: ILogger
    ) {
        const config = this.configLoader.load() as Mem0Config;
        this.baseUrl = config.infrastructure?.mem0?.url || 'http://localhost:8080';
        this.apiKey = config.infrastructure?.mem0?.apiKey || '';
    }

    async addMemories(input: {
        tenant_id: TenantId;
        user_id: UserId;
        session_id: SessionId;
        messages: SessionMessage[];
    }): Promise<DistilledFact[]> {
        this.logger.info(`Mem0Adapter: Extracting facts for session ${input.session_id}`, {
            tenant_id: input.tenant_id,
            msg_count: input.messages.length
        });

        const options: HttpClientRequestOptions = {
            method: 'POST',
            url: `${this.baseUrl}/v1/memories`,
            timeoutMs: 30000,
            headers: this.getHeaders(),
            body: {
                user_id: input.user_id,
                agent_id: input.tenant_id,
                run_id: input.session_id, // Session grouping for better search
                messages: input.messages.map(m => ({
                    role: m.role,
                    content: m.content
                }))
            }
        };

        const response = await this.httpClient.request(options);

        if (response.statusCode !== 200 && response.statusCode !== 201) {
            this.logger.error(`Mem0Adapter: Failed to add memories`, { status: response.statusCode, body: response.body });
            throw new Error(`Mem0 API error: ${response.statusCode}`);
        }

        let parsedBody: Mem0AddMemoriesResponse;
        try {
            parsedBody = JSON.parse(response.body) as Mem0AddMemoriesResponse;
        } catch (error) {
            this.logger.error(`Mem0Adapter: Failed to parse response body`, { 
                error: (error as Error).message,
                body: response.body.slice(0, 1000) // Log snippet
            });
            throw new Error(`Mem0 API invalid JSON: ${(error as Error).message}`);
        }

        const results = parsedBody?.results || [];
        return results.map((r: Mem0MemoryResponseRow) => ({
            id: r.id ?? '',
            text: r.memory ?? '',
            event: r.event ?? 'NONE',
            old_memory: r.old_memory
        }));
    }

    async searchFacts(input: {
        tenant_id: TenantId;
        user_id: UserId;
        query: string;
        limit?: number;
    }): Promise<DistilledFact[]> {
        const options: HttpClientRequestOptions = {
            method: 'POST',
            url: `${this.baseUrl}/v1/memories/search`,
            timeoutMs: 10000,
            headers: this.getHeaders(),
            body: {
                user_id: input.user_id,
                agent_id: input.tenant_id,
                query: input.query,
                limit: input.limit || 10
            }
        };

        const response = await this.httpClient.request(options);

        if (response.statusCode !== 200) {
            throw new Error(`Mem0 Search error: ${response.statusCode}`);
        }

        let results: Mem0MemoryResponseRow[];
        try {
            results = (JSON.parse(response.body) as Mem0MemoryResponseRow[]) || [];
        } catch (error) {
            this.logger.error(`Mem0Adapter: Failed to parse search results`, { 
                error: (error as Error).message,
                body: response.body.slice(0, 500)
            });
            return []; // Fail-safe for search: return empty instead of crashing
        }

        return results.map((r: Mem0MemoryResponseRow) => ({
            id: r.id ?? '',
            text: r.memory ?? '',
            event: 'NONE',
            metadata: r.metadata
        }));
    }

    private getHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Token ${this.apiKey}`
        };
    }
}
