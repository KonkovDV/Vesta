import { inject, injectable } from 'inversify';
import { DI_TOKENS } from '../../../ai-types';
import type { IHttpClient } from '../../http/HttpClient';
// Assuming IConfigLoader is not exported, we use ConfigLoader class as type if needed, 
// OR simpler: just use 'any' or check if ConfigLoader class is exported.
// Let's use ConfigLoader class import.
import { ConfigLoader } from '../../../config/ConfigLoader';

import { 
    ISessionMemoryManager 
} from '../../../domain/memory/ISessionMemoryManager';
import { 
    HSGClient 
} from '../../../domain/memory/session-memory-ports';
import {
    HSGAddToSectorInput,
    HSGQueryResultItem,
    HSGQueryInput
} from '../../../domain/memory/session-memory-ports';
import { 
    HSGPointer 
} from '../../../domain/memory/session-types';
import {
    SessionId,
    TenantId,
    UserId,
    CorrelationId,
    SessionMessage,
    SessionConfig,
    SessionMetadata,
    WorkingMemoryEntry
} from '../../../domain/memory/session-types';

interface OpenMemoryMatch {
    id?: HSGPointer;
    pointer?: HSGPointer;
    score?: number;
    salience?: number;
    content: string;
    metadata?: Record<string, unknown>;
    meta?: Record<string, unknown>;
}

interface OpenMemoryQueryResponse {
    matches?: OpenMemoryMatch[];
}

@injectable()
export class OpenMemoryAdapter implements ISessionMemoryManager, HSGClient {
    private readonly baseUrl: string;
    private readonly apiKey?: string;

    constructor(
        @inject('IConfigLoader') private readonly configLoader: ConfigLoader,
        @inject('HttpClient') private readonly httpClient: IHttpClient
    ) {
        const config = this.configLoader.get();
        
        if (!config.infra?.openmemory) {
            throw new Error('OpenMemory configuration is missing');
        }
        this.baseUrl = config.infra.openmemory.url;
        this.apiKey = config.infra.openmemory.apiKey;
    }



    // ============================================================================
    // HSGClient Implementation
    // ============================================================================

    async addToSector(input: HSGAddToSectorInput): Promise<HSGPointer> {
        // Map internal input to OpenMemory API (HMD v2)
        // POST /memory/add
        const tags = [input.primary_sector, ...(input.sectors || [])];

        const response = await this.httpClient.request({
            method: 'POST',
            url: `${this.baseUrl}/memory/add`,
            timeoutMs: 5000,
            headers: this.getHeaders(),
            body: {
                content: input.content,
                tags,
                metadata: input.metadata,
                user_id: input.user_id,
                // Note: OpenMemory v2 HMD uses user_id as primary discriminator
            }
        });

        if (response.statusCode >= 400) {
             throw new Error(`OpenMemory API Error (addToSector): ${response.statusCode} - ${response.body}`);
        }

        const data = this.safeJsonParse(response.body) as Record<string, unknown>;
        return (data.id || data.pointer) as HSGPointer; // Standardized to 'id' in HMD v2
    }

    async getMemory(input: { tenant_id: TenantId; hsg_id: string; correlation_id?: CorrelationId }): Promise<{ pointer: HSGPointer; content: string; metadata: Record<string, unknown> } | null> {
        const response = await this.httpClient.request({
            method: 'GET',
            url: `${this.baseUrl}/memory/${input.hsg_id}`, // Standard /memory/:id in HMD v2
            timeoutMs: 3000,
            headers: this.getHeaders()
        });

        if (response.statusCode === 404) return null;
        if (response.statusCode >= 400) {
            throw new Error(`OpenMemory API Error (getMemory): ${response.statusCode} - ${response.body}`);
        }

        const data = this.safeJsonParse(response.body) as Record<string, unknown>;
        return {
            pointer: (data.id || data.pointer) as HSGPointer,
            content: data.content as string,
            metadata: (data.metadata || data.meta || {}) as Record<string, unknown>
        };
    }

    async query(input: HSGQueryInput): Promise<HSGQueryResultItem[]> {
         const response = await this.httpClient.request({
            method: 'POST',
            url: `${this.baseUrl}/memory/query`, // Corrected from /search
            timeoutMs: 5000,
            headers: this.getHeaders(),
            body: {
                query: input.query,
                k: input.limit,
                user_id: input.user_id,
                filters: {
                    ...input.filters,
                    sector: Array.isArray(input.sector) ? input.sector[0] : input.sector,
                    user_id: input.user_id
                }
            }
        });

        if (response.statusCode >= 400) {
            throw new Error(`OpenMemory API Error (query): ${response.statusCode} - ${response.body}`);
        }

        const data = this.safeJsonParse(response.body);
        const matches = Array.isArray(data)
            ? data as OpenMemoryMatch[]
            : ((data as OpenMemoryQueryResponse).matches || []);

        return matches.map((m) => ({
            pointer: (m.id || m.pointer) as HSGPointer,
            score: m.score || m.salience || 0,
            content: m.content,
            metadata: m.metadata || m.meta || {}
        }));
    }

    async createRelationship(input: { tenant_id: TenantId; source_id: string; target_id: string; relationship: string; weight?: number; metadata?: Record<string, unknown>; correlation_id?: CorrelationId }): Promise<void> {
         const response = await this.httpClient.request({
            method: 'POST',
            url: `${this.baseUrl}/memory/relationships`,
            timeoutMs: 3000,
            headers: this.getHeaders(),
            body: input
        });

        if (response.statusCode >= 400) {
            throw new Error(`OpenMemory API Error: ${response.statusCode} - ${response.body}`);
        }
    }


    // ============================================================================
    // ISessionMemoryManager Implementation
    // ============================================================================

    async create_session(input: { tenant_id: TenantId; user_id: UserId; external_session_ref?: string; initial_context?: Record<string, unknown>; config_override?: Partial<SessionConfig>; correlation_id: CorrelationId }): Promise<{ session_id: SessionId; created: boolean; loaded_working_memory: number }> {
        const response = await this.httpClient.request({
            method: 'POST',
            url: `${this.baseUrl}/memory/session`,
            timeoutMs: 5000,
            headers: this.getHeaders(),
            body: {
                tenant_id: input.tenant_id,
                user_id: input.user_id,
                external_ref: input.external_session_ref,
                context: input.initial_context,
                config: input.config_override,
                correlation_id: input.correlation_id
            }
        });

        if (response.statusCode >= 400) {
            throw new Error(`OpenMemory create_session failed: ${response.statusCode} - ${response.body}`);
        }

        const data = JSON.parse(response.body);
        return {
            session_id: data.session_id,
            created: data.created,
            loaded_working_memory: data.loaded_working_memory ?? 0
        };
    }

    async add_message(input: { tenant_id: TenantId; session_id: SessionId; user_id?: UserId; role: SessionMessage['role']; modality?: SessionMessage['modality']; content: string; metadata?: SessionMessage['metadata']; correlation_id: CorrelationId }): Promise<{ session_id: SessionId; message_id: string; total_tokens: number; context_window_size: number; consolidation_triggered: boolean }> {
        const response = await this.httpClient.request({
            method: 'POST',
            url: `${this.baseUrl}/memory/session/${input.session_id}/message`,
            timeoutMs: 10000, // Message processing might take longer (embedding, etc.)
            headers: this.getHeaders(),
            body: {
                tenant_id: input.tenant_id,
                user_id: input.user_id,
                role: input.role,
                modality: input.modality,
                content: input.content,
                metadata: input.metadata,
                correlation_id: input.correlation_id
            }
        });

        if (response.statusCode >= 400) {
            throw new Error(`OpenMemory add_message failed: ${response.statusCode} - ${response.body}`);
        }

        const data = JSON.parse(response.body);
        return {
            session_id: input.session_id,
            message_id: data.message_id,
            total_tokens: data.total_tokens,
            context_window_size: data.context_window_size,
            consolidation_triggered: data.consolidation_triggered
        };
    }

    async get_context_window(input: { tenant_id: TenantId; session_id: SessionId; max_messages?: number; max_tokens?: number; correlation_id?: CorrelationId }): Promise<{ session_id: SessionId; messages: SessionMessage[] }> {
        const queryParams = new URLSearchParams();
        queryParams.append('tenant_id', input.tenant_id);
        if (input.max_messages) queryParams.append('limit', input.max_messages.toString());
        // max_tokens handling might need specific API support or client-side filtering
        
        const response = await this.httpClient.request({
            method: 'GET',
            url: `${this.baseUrl}/memory/session/${input.session_id}?${queryParams.toString()}`,
            timeoutMs: 3000,
            headers: this.getHeaders()
        });

        if (response.statusCode >= 400) {
            throw new Error(`OpenMemory get_context_window failed: ${response.statusCode} - ${response.body}`);
        }

        const data = JSON.parse(response.body);
        return {
            session_id: input.session_id,
            messages: data.messages // Assuming OM returns { messages: [] }
        };
    }

    async consolidate_session(input: { tenant_id: TenantId; session_id: SessionId; strategy?: 'auto' | 'full' | 'recent_window'; correlation_id: CorrelationId }): Promise<{ session_id: SessionId; summaries: WorkingMemoryEntry[]; consolidated_messages: number }> {
         const response = await this.httpClient.request({
            method: 'POST',
            url: `${this.baseUrl}/memory/session/${input.session_id}/consolidate`,
            timeoutMs: 20000, // Consolidation is heavy
            headers: this.getHeaders(),
            body: {
                strategy: input.strategy ?? 'auto',
                correlation_id: input.correlation_id
            }
        });

        if (response.statusCode >= 400) {
            throw new Error(`OpenMemory consolidate_session failed: ${response.statusCode} - ${response.body}`);
        }

        const data = JSON.parse(response.body);
        return {
            session_id: input.session_id,
            summaries: data.summaries,
            consolidated_messages: data.consolidated_messages
        };
    }

    async end_session(input: { tenant_id: TenantId; session_id: SessionId; reason?: string; correlation_id: CorrelationId }): Promise<{ session_id: SessionId; archived: boolean }> {
        const response = await this.httpClient.request({
            method: 'POST',
            url: `${this.baseUrl}/memory/session/${input.session_id}/archive`,
            timeoutMs: 3000,
            headers: this.getHeaders(),
            body: {
                reason: input.reason,
                correlation_id: input.correlation_id
            }
        });

        if (response.statusCode >= 400) {
             throw new Error(`OpenMemory end_session failed: ${response.statusCode} - ${response.body}`);
        }
        
        return {
            session_id: input.session_id,
            archived: true
        };
    }

    async get_session_state(input: { tenant_id: TenantId; session_id: SessionId }): Promise<{ metadata: SessionMetadata; working_memory: WorkingMemoryEntry[] }> {
        const queryParams = new URLSearchParams();
        queryParams.append('tenant_id', input.tenant_id);

        const response = await this.httpClient.request({
            method: 'GET',
            url: `${this.baseUrl}/memory/session/${input.session_id}/state?${queryParams.toString()}`,
            timeoutMs: 3000,
            headers: this.getHeaders()
        });

         if (response.statusCode >= 400) {
            throw new Error(`OpenMemory get_session_state failed: ${response.statusCode} - ${response.body}`);
        }

        const data = JSON.parse(response.body);
        return {
            metadata: data.metadata,
            working_memory: data.working_memory
        };
    }

    private safeJsonParse(body: string): unknown {
        try {
            return JSON.parse(body);
        } catch (e) {
            console.error('[OpenMemoryAdapter] Failed to parse response body as JSON:', body.slice(0, 100));
            throw new Error('Invalid JSON response from OpenMemory API');
        }
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        return headers;
    }
}
