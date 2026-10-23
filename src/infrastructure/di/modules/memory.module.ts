/**
 * Memory & Session DI module.
 * Registers HSG/Vector clients, vector store, memory stores, routing, governance
 * and governed session memory manager.
 * Layer: Infrastructure/DI.
 */
import type { IChatCompletionModel } from '../../../domain/ai/IChatCompletionModel';
import { ContentIngestionService } from '../../../memory/ingestion/ContentIngestionService';
import { IngestionController } from '../../../presentation/http/controllers/ingestion/IngestionController';
import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { SsrfDnsGuard } from '../../security/SsrfDnsGuard';
import { selectIngestionHttpClient } from '../../http/SsrfPinnedHttpClient';
import { getConfig } from '../../../config';
import type { ILogger } from '../../../core/decorators/ILogger';
import {
  SessionMemoryManager,
  InMemorySessionMemoryStore,
  InMemoryWorkingMemoryStore,
  NoopLongTermMemoryStore,
  DefaultSectorClassifier,
  DefaultMemoryRoutingPolicy,
} from '../../../memory/session/SessionMemoryManager';
import { OpenMemoryAdapter } from '../../memory/adapter/OpenMemoryAdapter';
import { Mem0Adapter } from '../../memory/adapter/Mem0Adapter';
import type { DistilledFact, IMemoryDistiller } from '../../memory/adapter/Mem0Adapter';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import type { IVectorStore } from '../../../domain/memory/IVectorStore';
import type { AdvancedRetrievalService } from '../../../domain/memory/AdvancedRetrievalService';
import {
  createAdvancedRetrievalService,
  createHybridMemoryRetrievalService,
} from '../../memory/MemoryRetrievalFactory';
import { PgVectorStore } from '../../vector/PgVectorStore';
import { SqliteVectorStore } from '../../memory/vector/sqlite-vector-store';
import { DualWriteMemoryManager } from '../../../memory/session/DualWriteMemoryManager';
import { EnvMemoryModeResolver } from '../../../memory/session/MemoryModeResolver';
import { LegacySessionMemoryStore } from '../../../memory/legacy/LegacySessionMemoryStore';
import { createOpenMemoryHSGClientFromEnv } from '../../memory/hsg/openmemory-hsg-client';
import { createQdrantVectorClientFromEnv } from '../../memory/vector/qdrant-vector-client';
import { GovernedSessionMemoryManager } from '../../../memory/session/GovernedSessionMemoryManager';
import { LoggerMemoryGovernanceAuditSink } from '../../memory/LoggerMemoryGovernanceAuditSink';
import { createDefaultMemoryGovernanceService } from '../../../memory/governance/memory-governance.service';
import { PolicyEngineMemoryAdapter } from '../../policy/memory-policy-engine.adapter';
import type { HybridMemoryRetrievalService } from '../../memory/retrieval/hybrid-memory-retrieval.service';
import type { HSGClient, LongTermMemoryStore } from '../../../domain/memory/session-memory-ports';
import { PostgresSessionMemoryStore } from '../../memory/session/PostgresSessionMemoryStore';
import { MemoryCleanupService } from '../../memory/memory-cleanup.service';
import { TransientThoughtRepository } from '../../memory/TransientThoughtRepository';
import { PostgresLongTermMemoryStore } from '../../memory/PostgresLongTermMemoryStore';
import { HybridSearchService } from '../../../domain/memory/services/hybrid-search.service';
import { MemoryEmbeddingIndexer } from '../../../domain/memory/services/memory-embedding-indexer';
import type { IMemoryEmbeddingIndexer } from '../../../domain/memory/IMemoryEmbeddingIndexer';
import { IAIClient } from '../../../domain/ai/IAIClient';
import { embedSearchQuery } from '../../../domain/memory/services/query-embedding';
import { parseMemoryRetrievalMode } from '../../memory/PostgresLongTermMemoryStore';
import { StubContentScanner, CONTENT_SCANNER_TOKEN } from '../../../domain/memory/governance/content-scanner';
import { InMemoryGovernanceAdminService, MEMORY_GOVERNANCE_ADMIN_TOKEN } from '../../../memory/governance/memory-governance-admin.service';
import { PresidioContentScanner, PresidioConfig } from '../../memory/presidio-content-scanner';
import { PostgresGovernanceAdminService } from '../../memory/PostgresGovernanceAdminService';
import { NodeHttpJsonClient } from '../../http/HttpClient';
import { SESSION_COUNTER_TOKEN } from '../../../domain/memory/governance/session-counter';
import { RedisSessionCounter } from '../../memory/RedisSessionCounter';
import { InMemorySessionCounter } from '../../memory/InMemorySessionCounter';
import { InMemoryCodeGraphAdapter } from '../../memory/graph/InMemoryCodeGraphAdapter';
import { createCodeGraphStoreFromEnv } from '../../memory/graph/code-graph-store.factory';
import { InMemoryGraphAdapter } from '../../../memory/graph/InMemoryGraphAdapter';
import type { ICodeGraphStore } from '../../../domain/memory/ICodeGraphStore';
import type { IGraphMemoryEngine } from '../../../domain/memory/IGraphMemoryEngine';
import type { IArchivalMemory } from '../../../domain/memory/IArchivalMemory';
import type { IEvaluationMemory } from '../../../domain/memory/IEvaluationMemory';
import type { IGovernanceMemory } from '../../../domain/memory/IGovernanceMemory';
import type { IProfileMemory } from '../../../domain/memory/IProfileMemory';
import type { IMemoryFactStore } from '../../../domain/memory/IMemoryFactStore';
import type { DomainEvent, IEventStore } from '../../../domain/events/event-store.interface';
import { emitMemoryGovernanceAuditEvents } from '../../../application/memory/memory-governance-events';
import { createAgentRunServiceFromTokens } from '../../../application/agents/create-agent-run-service';
import { ProposeMemoryFact } from '../../../application/memory/ProposeMemoryFact';
import { PersistIngestedFacts } from '../../../application/memory/PersistIngestedFacts';
import { PostgresMemoryFactStore } from '../../memory/PostgresMemoryFactStore';
import { InMemoryMemoryFactStore } from '../../memory/InMemoryMemoryFactStore';
import type { ISummaryMemory } from '../../../domain/memory/ISummaryMemory';
import type { IWorkingMemory } from '../../../domain/memory/IWorkingMemory';
import type { ILLMAdapterFactory } from '../../../domain/ai/ILLMAdapterFactory';
import type { IStructuredLogger } from '../../../core/logging/IStructuredLogger';
import type { IGraphMemoryAdapter } from '../../../domain/memory/graph-memory.port';
import { GraphMemoryEngine, type IGraphLLMAdapter, type IGraphMemoryLogger } from '../../memory/graph/GraphMemoryEngine';
import { createMem0Provider, type Mem0ProviderConfig } from '../../memory/provider/UnifiedMem0Provider';
import { Mem0MemoryProviderBridge } from '../../memory/provider/Mem0MemoryProviderBridge';
import { McpMemoryServer } from '../../mcp/McpMemoryServer';
import { wrapMcpServerWithRunAgent } from '../../mcp/wrap-mcp-server-with-run-agent';
import { AutoCaptureService } from '../../../application/services/memory/AutoCaptureService';
import { GovernanceMemoryAdapter } from '../../memory/GovernanceMemoryAdapter';
import { SummaryMemoryAdapter } from '../../memory/SummaryMemoryAdapter';
import { VectorArchivalProvider } from '../../context/adapters/VectorArchivalProvider';
import { WorkingMemoryAdapter } from '../../memory/WorkingMemoryAdapter';
import { LocalEmbeddingAdapter } from '../../context/embedding/LocalEmbeddingAdapter';
import type { Mem0BuilderConfig } from '../../../application/ports/Mem0OptionsBuilder';


function parseMem0JsonEnv(name: string): Record<string, unknown> | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  return JSON.parse(raw) as Record<string, unknown>;
}

function buildMem0ProviderConfigFromEnv(): Mem0ProviderConfig {
  return {
    mode: (process.env.MEM0_PROVIDER_MODE ?? process.env.MEM0_MODE ?? 'oss') as Mem0ProviderConfig['mode'],
    apiKey: process.env.MEM0_API_KEY,
    orgId: process.env.MEM0_ORG_ID,
    projectId: process.env.MEM0_PROJECT_ID,
    customPrompt: process.env.MEM0_CUSTOM_PROMPT,
    oss: {
      embedder: process.env.MEM0_OSS_EMBEDDER_PROVIDER
        ? {
            provider: process.env.MEM0_OSS_EMBEDDER_PROVIDER,
            config: parseMem0JsonEnv('MEM0_OSS_EMBEDDER_CONFIG') ?? {},
          }
        : undefined,
      vectorStore: process.env.MEM0_OSS_VECTOR_STORE_PROVIDER
        ? {
            provider: process.env.MEM0_OSS_VECTOR_STORE_PROVIDER,
            config: parseMem0JsonEnv('MEM0_OSS_VECTOR_STORE_CONFIG') ?? {},
          }
        : undefined,
      llm: process.env.MEM0_OSS_LLM_PROVIDER
        ? {
            provider: process.env.MEM0_OSS_LLM_PROVIDER,
            config: parseMem0JsonEnv('MEM0_OSS_LLM_CONFIG') ?? {},
          }
        : undefined,
      historyDbPath: process.env.MEM0_OSS_HISTORY_DB_PATH,
    },
  };
}

function buildMem0BuilderConfigFromEnv(): Mem0BuilderConfig & { autoCapture: boolean } {
  const parsedTopK = Number.parseInt(process.env.MEM0_TOP_K ?? '5', 10);
  const parsedThreshold = Number.parseFloat(process.env.MEM0_SEARCH_THRESHOLD ?? '0.3');

  return {
    mode: (process.env.MEM0_PROVIDER_MODE ?? process.env.MEM0_MODE ?? 'oss') as Mem0BuilderConfig['mode'],
    userId: process.env.MEM0_USER_ID ?? 'microphoenix',
    source: process.env.MEM0_SOURCE ?? 'MICROPHOENIX',
    enableGraph: process.env.MEM0_ENABLE_GRAPH !== 'false',
    searchThreshold: Number.isFinite(parsedThreshold) ? parsedThreshold : 0.3,
    topK: Number.isFinite(parsedTopK) ? parsedTopK : 5,
    autoCapture: process.env.MEM0_AUTO_CAPTURE !== 'false',
  };
}

function createMem0Logger() {
  return {
    info(message: string): void {
      console.info(message);
    },
    warn(message: string): void {
      console.warn(message);
    },
    error(message: string): void {
      console.error(message);
    },
    debug(message: string): void {
      console.debug(message);
    },
  };
}

function createUnavailableArchivalMemory(): IArchivalMemory {
  return {
    async search(): Promise<readonly []> {
      return [];
    },
    async getItemCount(): Promise<number> {
      return 0;
    },
    async getStatus() {
      return {
        available: false,
        itemCount: 0,
      };
    },
  };
}

function createGraphMemoryLogger(): IGraphMemoryLogger {
  if (container.isRegistered(DI_TOKENS.IStructuredLogger)) {
    return container.resolve<IStructuredLogger>(DI_TOKENS.IStructuredLogger);
  }

  return {
    info(message: string, meta?: Record<string, unknown>): void {
      console.info(message, meta);
    },
    warn(message: string, meta?: Record<string, unknown>): void {
      console.warn(message, meta);
    },
    error(message: string, meta?: Record<string, unknown>): void {
      console.error(message, meta);
    },
    debug(message: string, meta?: Record<string, unknown>): void {
      console.debug(message, meta);
    },
  };
}

function createMemoryModuleLogger(): Pick<IStructuredLogger, 'warn'> {
  if (container.isRegistered(DI_TOKENS.IStructuredLogger)) {
    return container.resolve<IStructuredLogger>(DI_TOKENS.IStructuredLogger);
  }

  return {
    warn(message: string, meta?: Record<string, unknown>): void {
      console.warn(message, meta);
    },
  };
}

function createLongTermMemoryStore(): PostgresLongTermMemoryStore {
  const mode = parseMemoryRetrievalMode(process.env.MEMORY_RETRIEVAL_MODE);
  return new PostgresLongTermMemoryStore(
    container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection),
    () => (
      container.isRegistered(DI_TOKENS.IMemoryEmbeddingIndexer) && container.isRegistered(DI_TOKENS.IAIClient)
        ? container.resolve<IMemoryEmbeddingIndexer>(DI_TOKENS.IMemoryEmbeddingIndexer)
        : undefined
    ),
    createMemoryModuleLogger(),
    {
      mode,
      embedQuery: async (query: string) => {
        if (!container.isRegistered(DI_TOKENS.IAIClient)) return null;
        return embedSearchQuery(container.resolve<IAIClient>(DI_TOKENS.IAIClient), query);
      },
    },
  );
}

function createSqliteVectorStoreLogger(): ILogger {
  if (container.isRegistered(DI_TOKENS.ILogger)) {
    return container.resolve<ILogger>(DI_TOKENS.ILogger);
  }

  return {
    log(message: string, meta?: Record<string, unknown>): void {
      console.log(message, meta);
    },
    error(message: string, meta?: Record<string, unknown>): void {
      console.error(message, meta);
    },
    warn(message: string, meta?: Record<string, unknown>): void {
      console.warn(message, meta);
    },
    debug(message: string, meta?: Record<string, unknown>): void {
      console.debug(message, meta);
    },
    info(message: string, meta?: Record<string, unknown>): void {
      console.info(message, meta);
    },
  };
}

type VectorStoreProvider = 'sqlite' | 'pgvector';

function resolveVectorStoreProvider(): VectorStoreProvider {
  const rawProvider = process.env.VECTOR_STORE_PROVIDER?.trim().toLowerCase();

  if (rawProvider === 'sqlite' || rawProvider === 'pgvector') {
    return rawProvider;
  }

  if (rawProvider && rawProvider.length > 0) {
    createMemoryModuleLogger().warn('Unknown VECTOR_STORE_PROVIDER; using default provider', {
      requestedProvider: rawProvider,
      fallbackProvider: process.env.NODE_ENV === 'production' ? 'pgvector' : 'sqlite',
    });
  }

  return process.env.NODE_ENV === 'production' ? 'pgvector' : 'sqlite';
}

function createVectorStoreConfigurationError(provider: VectorStoreProvider): Error {
  return new Error(
    `IVectorStore provider "${provider}" requires IDatabaseConnection to be registered`,
  );
}

function createVectorStore(): IVectorStore {
  const provider = resolveVectorStoreProvider();

  if (provider === 'pgvector') {
    if (!container.isRegistered(DI_TOKENS.IDatabaseConnection)) {
      throw createVectorStoreConfigurationError(provider);
    }

    return new PgVectorStore(container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection), {
      table: 'long_term_memories',
    });
  }

  return new SqliteVectorStore(
    createSqliteVectorStoreLogger(),
    process.env.SQLITE_VECTOR_STORE_PATH ?? 'openclaw_memory.db',
  );
}

type DurableMemoryPlane = 'profile' | 'evaluation';

function isDurabilityStrictGateEnabled(): boolean {
  const explicit = process.env.MEMORY_DURABILITY_STRICT;
  if (explicit === 'true') {
    return true;
  }

  return process.env.NODE_ENV === 'production';
}

function createDurabilityGateError(plane: DurableMemoryPlane): Error {
  return new Error(
    `Durable ${plane} memory requires IDatabaseConnection when MEMORY_DURABILITY_STRICT is enabled or NODE_ENV=production`,
  );
}

function createNoopDurabilityWarning(plane: DurableMemoryPlane): void {
  createMemoryModuleLogger().warn('Durable memory plane resolved to noop fallback', {
    plane,
    fallback: 'NoopLongTermMemoryStore',
    reason: 'IDatabaseConnection is not registered',
    strictMode: isDurabilityStrictGateEnabled(),
  });
}

function createGraphMemoryLlmBridge(): IGraphLLMAdapter {
  return {
    async generateMultimodalChat(messages, options) {
      if (!container.isRegistered(DI_TOKENS.LLMAdapterFactory)) {
        throw new Error(
          'GraphMemoryEngine requires DI_TOKENS.LLMAdapterFactory for tool-calling operations.',
        );
      }

      const llmFactory = container.resolve<ILLMAdapterFactory>(DI_TOKENS.LLMAdapterFactory);
      const { adapter } = await llmFactory.createAdapterWithFailover(undefined, options);
      return adapter.generateMultimodalChat(messages, options);
    },
  };
}


export function registerMemoryModuleServices(): void {
  try {
    // Infrastructure HTTP client used by OpenMemory adapters
    container.register(
      'HttpClient',
      () => new NodeHttpJsonClient(),
      {
        lifecycle: 'singleton',
        tags: ['infrastructure', 'http', 'client'],
        description: 'Node.js http/https client wrapper (IHttpClient)',
      },
    );

    // Infra-level HSG client
    container.register(
      'HSGClient',
      () => createOpenMemoryHSGClientFromEnv(),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'hsg', 'openmemory'],
        description:
          'OpenMemory HSG client (stubbed; HTTP wiring to be added in Phase 11)',
        aspectOptions: {
          // Аннотации для CircuitBreakerAspect: канал MEMORY поверх HTTP.
          annotations: ['memory', 'http'],
          metadata: {
            integrationName: 'openmemory_hsg',
          },
        },
      },
    );

    // OpenMemory Adapter (External Service Bridge)
    container.register(
      DI_TOKENS.OpenMemoryAdapter,
      (c) => new OpenMemoryAdapter(
        c.resolve(DI_TOKENS.IConfigLoader),
        c.resolve(DI_TOKENS.HttpClient) // Assuming HttpClient is registered as 'HttpClient' or we use NodeHttpJsonClient directly if not
      ),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'adapter', 'openmemory'],
        description: 'OpenMemory Adapter bridging ISessionMemoryManager to External API',
      }
    );

    // Infra-level Vector client (Qdrant/OpenMemory HTTP client; stubbed semantics in non-production)
    container.register(
      'VectorClient',
      () => createQdrantVectorClientFromEnv(),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'vector', 'qdrant'],
        description:
          'Qdrant/OpenMemory Vector client (HTTP-backed in production, stubbed semantics in non-production)',
        aspectOptions: {
          // Аннотации для CircuitBreakerAspect: канал MEMORY поверх HTTP.
          annotations: ['memory', 'http'],
          metadata: {
            integrationName: 'openmemory_vector',
          },
        },
      },
    );

    // Infra-level Vector store (sqlite-vec) - Local Semantic Memory
    container.register<IVectorStore>(
      'IVectorStore',
      () => createVectorStore(),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'vector', 'store'],
        description:
          'Environment-resolved implementation of IVectorStore (pgvector in production by default, sqlite for local/test unless overridden)',
      },
    );

    if (!container.isRegistered(DI_TOKENS.IArchivalMemoryAdapter)) {
      container.register<IArchivalMemory>(
        DI_TOKENS.IArchivalMemoryAdapter,
        (c) => {
          if (!c.isRegistered(DI_TOKENS.IDatabaseConnection)) {
            return createUnavailableArchivalMemory();
          }

          return new VectorArchivalProvider(
            c.resolve(DI_TOKENS.IDatabaseConnection),
            new LocalEmbeddingAdapter(),
            c.isRegistered(DI_TOKENS.ILogger) ? c.resolve(DI_TOKENS.ILogger) : undefined,
          );
        },
        {
          lifecycle: 'singleton',
          tags: ['memory', 'archival', 'tier3', 'adapter'],
          description: 'Canonical archival adapter (pgvector when DB is available, explicit unavailable plane otherwise)',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.IArchivalMemory)) {
      container.register<IArchivalMemory>(
        DI_TOKENS.IArchivalMemory,
        (c) => c.resolve(DI_TOKENS.IArchivalMemoryAdapter),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'archival', 'tier3'],
          description: 'Cold-tier archival memory plane surface for standalone inspection and Tier 3 retrieval',
        },
      );
    }

    // Domain-level advanced retrieval service used by Application AdvancedRetrievalUseCase.
    // Memory snapshot reader wiring is deferred; vector-only retrieval is sufficient for bootstrap/tests.
    container.register<AdvancedRetrievalService>(
      'AdvancedRetrievalService',
      (c) => {
        const vectorStore = c.resolve<IVectorStore>(DI_TOKENS.IVectorStore);
      const mem0 = c.resolve<IMemoryDistiller>('Mem0Adapter');
        type SearchFact = DistilledFact & { score?: number };
        
        const semanticFactReader = {
        searchMemory: async (req: {
          tenantId: string;
          userId?: string;
          query: string;
          topK?: number;
        }) => {
                const facts = await mem0.searchFacts({
                    tenant_id: req.tenantId,
                    user_id: req.userId || 'anonymous',
                    query: req.query,
                    limit: req.topK
                });
          return facts.map((f: SearchFact) => ({
                    id: f.id,
                    content: f.text,
                    score: f.score || 0.95,
                    metadata: f.metadata
                }));
            }
        };

        return createAdvancedRetrievalService({ 
            vectorStore,
            semanticFactReader,
            embedder: c.isRegistered(DI_TOKENS.IAIClient)
              ? c.resolve<IAIClient>(DI_TOKENS.IAIClient)
              : undefined,
        });
      },
      {
        lifecycle: 'singleton',
        tags: ['memory', 'retrieval', 'advanced'],
        description:
          'AdvancedRetrievalService over IVectorStore + Mem0 Semantic L2',
      },
    );
  
    // Memory-layer stores
    // REPLACED: InMemorySessionMemoryStore -> PostgresSessionMemoryStore (Persistence Fix)
    container.register(
      'SessionMemoryStore',
      (c) => new PostgresSessionMemoryStore(c.resolve(DI_TOKENS.IDatabaseConnection)),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'session', 'store', 'postgres'],
        description: 'PostgreSQL-backed SessionMemoryStore (using conversations/messages tables)',
      },
    );

    container.register(
      'LegacySessionMemoryStore',
      () => new LegacySessionMemoryStore(),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'session', 'store', 'legacy'],
        description: 'LegacySessionMemoryStore facade over legacy session storage (Phase 5–7)',
      },
    );

    container.register(
      'WorkingMemoryStore',
      () => new InMemoryWorkingMemoryStore(),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'working', 'store', 'in-memory'],
        description: 'In-memory WorkingMemoryStore for development and tests',
      },
    );

    if (!container.isRegistered(DI_TOKENS.IWorkingMemory)) {
      container.register<IWorkingMemory>(
        DI_TOKENS.IWorkingMemory,
        (c) => new WorkingMemoryAdapter(c.resolve('WorkingMemoryStore')),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'working', 'plane'],
          description: 'Explicit working-memory plane surface over the canonical WorkingMemoryStore',
        },
      );
    }

    container.register(
      'LongTermMemoryStore',
      () => createLongTermMemoryStore(),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'long-term', 'store', 'postgres', 'bm25'],
        description: 'PostgreSQL-backed LongTermMemoryStore with BM25 (tsvector) search',
      },
    );

    if (!container.isRegistered(DI_TOKENS.IProfileMemory)) {
      container.register<IProfileMemory>(
        DI_TOKENS.IProfileMemory,
        (c) => {
          if (c.isRegistered(DI_TOKENS.IDatabaseConnection)) {
            return createLongTermMemoryStore();
          }

          if (isDurabilityStrictGateEnabled()) {
            throw createDurabilityGateError('profile');
          }

          createNoopDurabilityWarning('profile');
          return new NoopLongTermMemoryStore();
        },
        {
          lifecycle: 'singleton',
          tags: ['memory', 'profile', 'plane'],
          description: 'Canonical profile-memory plane with replace-vs-merge semantics',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.IMemoryFactStore)) {
      container.register<IMemoryFactStore>(
        DI_TOKENS.IMemoryFactStore,
        (c) => (
          c.isRegistered(DI_TOKENS.IDatabaseConnection)
            ? new PostgresMemoryFactStore(c.resolve(DI_TOKENS.IDatabaseConnection))
            : new InMemoryMemoryFactStore()
        ),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'facts', 'bitemporal'],
          description: 'Bitemporal memory_facts. Rows are written only from MemoryFactProposed',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.ProposeMemoryFact)) {
      container.register(
        DI_TOKENS.ProposeMemoryFact,
        (c) => new ProposeMemoryFact(
          c.resolve<IEventStore>(DI_TOKENS.IEventStore),
          c.resolve<IMemoryFactStore>(DI_TOKENS.IMemoryFactStore),
          c.isRegistered(DI_TOKENS.IStructuredLogger)
            ? c.resolve(DI_TOKENS.IStructuredLogger)
            : undefined,
        ),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'facts', 'events'],
          description: 'ASI06 gate, then MemoryFactProposed, then the fact row',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.IEvaluationMemory)) {
      container.register<IEvaluationMemory>(
        DI_TOKENS.IEvaluationMemory,
        (c) => {
          if (c.isRegistered(DI_TOKENS.IDatabaseConnection)) {
            return createLongTermMemoryStore();
          }

          if (isDurabilityStrictGateEnabled()) {
            throw createDurabilityGateError('evaluation');
          }

          createNoopDurabilityWarning('evaluation');
          return new NoopLongTermMemoryStore();
        },
        {
          lifecycle: 'singleton',
          tags: ['memory', 'evaluation', 'plane'],
          description: 'Canonical evaluation-memory plane for durable runs, verdicts, and scorecards',
        },
      );
    }

    // Classification & routing
    container.register(
      'SectorClassifier',
      () => new DefaultSectorClassifier(),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'hsg', 'classification'],
        description: 'Default heuristic SectorClassifier for HSG sectors',
      },
    );

    container.register(
      'MemoryRoutingPolicy',
      () => new DefaultMemoryRoutingPolicy(),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'routing'],
        description: 'Default routing policy that maps entries to HSG/Vector targets',
      },
    );

    // Memory mode resolver (env/config based)
    container.register(
      'MemoryModeResolver',
      () => new EnvMemoryModeResolver(),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'mode', 'config'],
        description: 'Resolves memory mode (legacy-only / dual-write / openmemory-only) based on env/config',
      },
    );

    // Governance services (Memory layer)
    container.register(
      'IMemoryPolicyEngineAdapter',
      (c) =>
        new PolicyEngineMemoryAdapter(
          c.resolve(DI_TOKENS.PolicyEngine),
          c.isRegistered(DI_TOKENS.ILogger) ? c.resolve(DI_TOKENS.ILogger) : console,
        ),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'governance', 'policy', 'runtime'],
        description:
          'Memory PolicyEngine adapter over shared PolicyEngine runtime',
      },
    );

    container.register(
      'IMemoryGovernanceAuditSink',
      (c) => {
        const journal = c.isRegistered('eventStoreService')
          ? c.resolve<{ saveDomainEvents(events: DomainEvent[]): Promise<void> }>('eventStoreService')
          : c.isRegistered(DI_TOKENS.IEventStore)
            ? {
                saveDomainEvents: (events: DomainEvent[]) =>
                  c.resolve<IEventStore>(DI_TOKENS.IEventStore).saveEvents(events).then(() => undefined),
              }
            : undefined;
        return new LoggerMemoryGovernanceAuditSink(async (input) => {
          await emitMemoryGovernanceAuditEvents({
            ...input,
            ...(journal ? { eventStoreService: journal } : {}),
          });
        });
      },
      {
        lifecycle: 'singleton',
        tags: ['memory', 'governance', 'audit'],
        description:
          'Logger-based Memory Governance audit sink (logs memory.governance.decision without PII)',
      },
    );

    container.register(
      'IMemoryGovernanceService',
      (c) =>
        createDefaultMemoryGovernanceService(
          c.resolve(DI_TOKENS.IMemoryPolicyEngineAdapter),
          c.resolve(DI_TOKENS.IMemoryGovernanceAuditSink),
        ),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'governance', 'quota'],
        description:
          'StaticQuotaMemoryGovernanceService implementing basic per-tenant/session quotas for Memory API',
      },
    );

    // Content Scanner for PII/sensitivity detection (MEM-NEXT.1)
    // Feature flag: PRESIDIO_SCANNER_ENABLED=true → use PresidioContentScanner
    const presidioEnabled = process.env.PRESIDIO_SCANNER_ENABLED === 'true';
    if (presidioEnabled && process.env.PRESIDIO_ANALYZER_URL && process.env.PRESIDIO_ANONYMIZER_URL) {
      const presidioConfig: PresidioConfig = {
        analyzerUrl: process.env.PRESIDIO_ANALYZER_URL,
        anonymizerUrl: process.env.PRESIDIO_ANONYMIZER_URL,
        minConfidence: Number(process.env.PRESIDIO_MIN_CONFIDENCE ?? '0.5'),
        language: process.env.PRESIDIO_LANGUAGE ?? 'en',
        timeoutMs: Number(process.env.PRESIDIO_TIMEOUT_MS ?? '5000'),
      };
      container.register(
        CONTENT_SCANNER_TOKEN,
        () => new PresidioContentScanner(new NodeHttpJsonClient(), presidioConfig),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'governance', 'security', 'pii', 'presidio'],
          description: 'Presidio-backed content scanner for production PII detection',
        },
      );
    } else {
      container.register(
        CONTENT_SCANNER_TOKEN,
        () => new StubContentScanner(),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'governance', 'security', 'pii'],
          description: 'Stub content scanner for MVP (always allows content, no PII detection)',
        },
      );
    }

    // Governance Admin Service for runtime quota management (MEM-NEXT.1)
    // Feature flag: GOVERNANCE_ADMIN_POSTGRES=true → use PostgreSQL
    const usePostgresAdmin = process.env.GOVERNANCE_ADMIN_POSTGRES === 'true';
    if (usePostgresAdmin) {
      container.register(
        MEMORY_GOVERNANCE_ADMIN_TOKEN,
        (c) => new PostgresGovernanceAdminService(c.resolve(DI_TOKENS.IDatabaseConnection)),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'governance', 'admin', 'postgres'],
          description: 'PostgreSQL-backed admin service for persistent quota overrides',
        },
      );
    } else {
      container.register(
        MEMORY_GOVERNANCE_ADMIN_TOKEN,
        () => new InMemoryGovernanceAdminService(),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'governance', 'admin'],
          description: 'In-memory admin service for quota overrides (production: use PostgreSQL)',
        },
      );
    }

    // Session Counter (MEM-NEXT.1 Production Hardening)
    // Feature flag: SESSION_COUNTER_REDIS=true → use RedisSessionCounter
    // Note: Reuses Redis configuration from env if available
    const useRedisCounter = process.env.SESSION_COUNTER_REDIS === 'true' || (process.env.REDIS_HOST && process.env.NODE_ENV === 'production');
    
    if (useRedisCounter) {
      container.register(
        SESSION_COUNTER_TOKEN,
        () => {
          const Redis = require('ioredis');
          const redis = new Redis({
             host: process.env.REDIS_HOST || 'localhost',
             port: Number(process.env.REDIS_PORT || 6379),
             password: process.env.REDIS_PASSWORD,
             db: Number(process.env.REDIS_DB || 0),
          });
          return new RedisSessionCounter(redis);
        },
        {
          lifecycle: 'singleton',
          tags: ['memory', 'governance', 'counter', 'redis'],
          description: 'Redis-backed session counter',
        },
      );
    } else {
      container.register(
        SESSION_COUNTER_TOKEN,
        () => new InMemorySessionCounter(),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'governance', 'counter', 'in-memory'],
          description: 'In-memory session counter (non-persistent)',
        },
      );
    }

    // Session memory manager core (Dual-write facade)
    container.register(
      'ISessionMemoryManagerCore',
      (c) => {
        // Use the real OpenMemoryAdapter for the OpenMemory leg of DualWrite
        const openMemoryManager = c.resolve<OpenMemoryAdapter>(DI_TOKENS.OpenMemoryAdapter);

        const legacySessionStore = c.resolve<LegacySessionMemoryStore>('LegacySessionMemoryStore');
        const legacyManager = new SessionMemoryManager(
          legacySessionStore,
          c.resolve('WorkingMemoryStore'),
          c.resolve(DI_TOKENS.LongTermMemoryStore),
          c.resolve('SectorClassifier'),
          c.resolve('MemoryRoutingPolicy'),
          c.resolve(DI_TOKENS.HSGClient),
          c.resolve(DI_TOKENS.VectorClient),
          c.resolve('Mem0Adapter'),
        );

        const modeResolver = c.resolve<EnvMemoryModeResolver>('MemoryModeResolver');

        return new DualWriteMemoryManager(
          legacyManager,
          openMemoryManager,
          modeResolver,
        );
      },
      {
        lifecycle: 'singleton',
        tags: ['memory', 'session', 'manager', 'dual-write', 'core'],
        description:
          'DualWriteMemoryManager coordinating legacy and OpenMemory backends for Session Memory API (governance-unaware core)',
      },
    );

    // Governance-decorated Session Memory API
    container.register(
      'ISessionMemoryManager',
      (c) =>
        new GovernedSessionMemoryManager(
          c.resolve(DI_TOKENS.ISessionMemoryManagerCore),
          c.resolve(DI_TOKENS.IMemoryGovernanceService),
          c.resolve(CONTENT_SCANNER_TOKEN), // IContentScanner injection (MEM-NEXT.1)
          c.resolve(SESSION_COUNTER_TOKEN), // ISessionCounter injection (MEM-NEXT.1)
        ),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'session', 'manager', 'governed'],
        description:
          'GovernedSessionMemoryManager decorator adding governance/quota enforcement and PII scanning over DualWriteMemoryManager core',
      },
    );

    if (!container.isRegistered(DI_TOKENS.ISummaryMemory)) {
      container.register<ISummaryMemory>(
        DI_TOKENS.ISummaryMemory,
        (c) => new SummaryMemoryAdapter(c.resolve(DI_TOKENS.ISessionMemoryManager)),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'summary', 'plane'],
          description: 'Explicit summary-memory plane surface over governed session consolidation',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.IGovernanceMemory)) {
      container.register<IGovernanceMemory>(
        DI_TOKENS.IGovernanceMemory,
        (c) =>
          new GovernanceMemoryAdapter(
            c.resolve(DI_TOKENS.IMemoryGovernanceService),
            c.resolve(MEMORY_GOVERNANCE_ADMIN_TOKEN),
            c.isRegistered(DI_TOKENS.IDatabaseConnection)
              ? c.resolve(DI_TOKENS.IDatabaseConnection)
              : undefined,
          ),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'governance', 'plane'],
          description:
            'Explicit governance-memory plane over quota evaluation and tenant override administration',
        },
      );
    }

    // Mem0 Adapter (L2 Semantic Layer)
    container.register(
      'Mem0Adapter',
      (c) => new Mem0Adapter(
        c.resolve(DI_TOKENS.HttpClient),
        c.resolve('ConfigLoader'),
        c.resolve(DI_TOKENS.ILogger)
      ),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'adapter', 'mem0', 'semantic'],
        description: 'Mem0 Adapter for intelligent knowledge distillation',
      }
    );

    if (!container.isRegistered(DI_TOKENS.IMem0Provider)) {
      container.register(
        DI_TOKENS.IMem0Provider,
        () => createMem0Provider(buildMem0ProviderConfigFromEnv(), createMem0Logger()),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'mem0', 'provider'],
          description: 'Unified Mem0 provider (platform or OSS) for memory runtime and tools',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.Mem0MemoryProviderBridge)) {
      container.register(
        DI_TOKENS.Mem0MemoryProviderBridge,
        (c) => new Mem0MemoryProviderBridge(
          c.resolve(DI_TOKENS.IMem0Provider),
          process.env.MEM0_USER_ID ?? 'microphoenix',
          process.env.MEM0_SOURCE ?? 'MICROPHOENIX',
          createMem0Logger(),
        ),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'mem0', 'bridge'],
          description: 'Backward-compatible bridge from IMem0Provider to legacy IMemoryProvider contract',
        },
      );
    }

    // Canonical IMemoryProvider: resolves via Mem0MemoryProviderBridge (IMem0Provider → IMemoryProvider adaptation).
    // Authority: IMem0Provider is the runtime SSOT; IMemoryProvider is the legacy generic facade.
    if (!container.isRegistered(DI_TOKENS.IMemoryProvider)) {
      container.register(
        DI_TOKENS.IMemoryProvider,
        (c) => c.resolve(DI_TOKENS.Mem0MemoryProviderBridge),
        {
          lifecycle: 'singleton',
          tags: ['memory', 'provider', 'canonical'],
          description: 'Canonical IMemoryProvider resolved via Mem0MemoryProviderBridge (IMem0Provider → IMemoryProvider)',
        },
      );
    }

    if (!container.isRegistered(DI_TOKENS.IMcpServer)) {
      container.register(
        DI_TOKENS.IMcpServer,
        (c) => wrapMcpServerWithRunAgent(c, new McpMemoryServer(c.resolve(DI_TOKENS.IMem0Provider), {
          workingMemory: c.isRegistered(DI_TOKENS.IWorkingMemory)
            ? c.resolve(DI_TOKENS.IWorkingMemory)
            : undefined,
          archivalMemory: c.isRegistered(DI_TOKENS.IArchivalMemory)
            ? c.resolve(DI_TOKENS.IArchivalMemory)
            : undefined,
          graphMemoryEngine: c.isRegistered(DI_TOKENS.IGraphMemoryEngine)
            ? c.resolve(DI_TOKENS.IGraphMemoryEngine)
            : undefined,
          adaptiveMemoryRetrieval: c.isRegistered(DI_TOKENS.IAdaptiveMemoryRetrieval)
            ? c.resolve(DI_TOKENS.IAdaptiveMemoryRetrieval)
            : undefined,
        }), createAgentRunServiceFromTokens(c)),
        {
          lifecycle: 'singleton',
          tags: ['mcp', 'memory', 'runtime'],
          description: 'Runtime MCP memory server backed by IMem0Provider',
        },
      );
    }

    if (container.isRegistered(DI_TOKENS.IHookPipeline) && !container.isRegistered(DI_TOKENS.AutoCaptureService)) {
      container.register(
        DI_TOKENS.AutoCaptureService,
        (c) => {
          const service = new AutoCaptureService(
            c.resolve(DI_TOKENS.IHookPipeline),
            c.resolve(DI_TOKENS.IMem0Provider),
            buildMem0BuilderConfigFromEnv(),
            c.isRegistered(DI_TOKENS.ILogger)
              ? c.resolve(DI_TOKENS.ILogger)
              : createMem0Logger(),
          );
          service.initialize();
          return service;
        },
        {
          lifecycle: 'singleton',
          tags: ['memory', 'mem0', 'capture', 'hooks'],
          description: 'Auto-capture service for agent_end and before_compaction checkpoint persistence',
        },
      );

      container.resolve(DI_TOKENS.AutoCaptureService);
    }

    // HybridMemoryRetrievalService lives in Memory layer, but must be registered in Infra DI
    // so Application use-cases (RagQueryService/SemanticSearchUseCase) can resolve it.
    container.register<HybridMemoryRetrievalService>(
      DI_TOKENS.hybridMemoryRetrievalService,
      (c) => {
        const hsgClient = c.resolve<HSGClient>(DI_TOKENS.HSGClient);
        const profileMemory = c.resolve<IProfileMemory>(DI_TOKENS.IProfileMemory);
        return createHybridMemoryRetrievalService({ hsgClient, profileMemory });
      },

      {
        lifecycle: 'singleton',
        tags: ['memory', 'retrieval', 'hybrid'],
        description:
          'HybridMemoryRetrievalService over HSGClient (KB-only adapter; vector retrieval TBD)',
      },
    );

    // Domain-level Hybrid Search Service (Vector + Keyword RRF) - Phase B.2
    container.register(
      'HybridSearchService',
      (c) => new HybridSearchService(
        c.resolve(DI_TOKENS.IVectorStore),
        c.resolve(DI_TOKENS.IProfileMemory),
        c.resolve<IAIClient>(DI_TOKENS.IAIClient) // Assumes IAIClient is registered in AI module
      ),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'search', 'hybrid', 'rrf'],
        description: 'HybridSearchService implementing RRF fusion of Vector and Keyword search',
      }
    );

    container.register<IMemoryEmbeddingIndexer>(
      DI_TOKENS.IMemoryEmbeddingIndexer,
      (c) => new MemoryEmbeddingIndexer(
        c.resolve<IVectorStore>(DI_TOKENS.IVectorStore),
        c.resolve<IAIClient>(DI_TOKENS.IAIClient),
      ),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'vector', 'embedding'],
        description: 'Embeds long-term memory rows on write with the same model HybridSearchService queries',
      },
    );


    // Memory Maintenance Services
    container.register(
      'TransientThoughtRepository',
      (c) => new TransientThoughtRepository(c.resolve(DI_TOKENS.IDatabaseConnection)),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'repository', 'transient'],
        description: 'Repository for transient thoughts',
      },
    );

    // ── Code Intelligence: Graph Memory ──

    // ICodeGraphStore (Code Knowledge Graph — KuzuDB or InMemory fallback)
    container.register<ICodeGraphStore>(
      DI_TOKENS.ICodeGraphStore,
      () => createCodeGraphStoreFromEnv().store,
      {
        lifecycle: 'singleton',
        tags: ['memory', 'graph', 'code-intelligence'],
        description: 'Code knowledge graph store (KuzuDB or in-memory fallback)',
      },
    );

    // IGraphMemoryAdapter (Entity relationship graph — InMemory fallback)
    container.register<IGraphMemoryAdapter>(
      DI_TOKENS.IGraphMemoryAdapter,
      () => {
        // Neo4j adapter requires NEO4J_URI env var.
        // Fallback to InMemory if not configured.
        const neo4jUri = process.env.NEO4J_URI;
        if (neo4jUri) {
          try {
            const { Neo4jGraphAdapter } = require('../../../memory/graph/Neo4jGraphAdapter');
            return new Neo4jGraphAdapter({
              uri: neo4jUri,
              username: process.env.NEO4J_USERNAME ?? 'neo4j',
              password: process.env.NEO4J_PASSWORD ?? '',
            });
          } catch {
            // Neo4j driver not available
          }
        }
        return new InMemoryGraphAdapter();
      },
      {
        lifecycle: 'singleton',
        tags: ['memory', 'graph', 'entity-relations'],
        description: 'Entity relationship graph adapter (Neo4j or in-memory fallback)',
      },
    );

    container.register<IGraphMemoryEngine>(
      DI_TOKENS.IGraphMemoryEngine,
      (c) => new GraphMemoryEngine(
        c.resolve<IGraphMemoryAdapter>(DI_TOKENS.IGraphMemoryAdapter),
        createGraphMemoryLlmBridge(),
        createGraphMemoryLogger(),
      ),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'graph', 'entity-relations', 'llm'],
        description: 'High-level graph memory engine for entity-relation extraction and retrieval',
      },
    );

    container.register(
      'MemoryCleanupService',
      (c) => new MemoryCleanupService(c.resolve('TransientThoughtRepository')),
      {
        lifecycle: 'singleton',
        tags: ['memory', 'maintenance', 'cleanup'],
        description: 'Service for cleaning up transient thoughts (24h retention)',
      },
    );

    if (getConfig().NODE_ENV !== 'test') {
      const cleanupService = container.resolve<MemoryCleanupService>('MemoryCleanupService');
      cleanupService.start();
    }

    if (!container.isRegistered('IngestionController')) {
      container.register('IngestionController', () => {
        const llm = {
          async generateText(prompt: string): Promise<{ text: string }> {
            if (container.isRegistered(DI_TOKENS.ILLMAdapter)) {
              const adapter = container.resolve<{ generateText?: (value: string) => Promise<{ text: string }> }>(DI_TOKENS.ILLMAdapter);
              if (adapter.generateText) return adapter.generateText(prompt);
            }
            if (!container.isRegistered(DI_TOKENS.IChatCompletionModel)) {
              throw new Error('Chat model is not configured');
            }
            const model = container.resolve<IChatCompletionModel>(DI_TOKENS.IChatCompletionModel);
            const completion = await model.complete(
              [{ role: 'user', content: prompt }],
              { maxOutputTokens: 400, correlationId: 'memory-ingest' },
            );
            return { text: completion.message.content };
          },
        };
        const pdf = container.isRegistered('IPDFParser') ? container.resolve('IPDFParser') : undefined;
        const fallbackHttp = container.isRegistered('HttpClient')
          ? container.resolve('HttpClient')
          : container.isRegistered('IHttpClient')
            ? container.resolve('IHttpClient')
            : undefined;
        const guard = container.isRegistered(DI_TOKENS.ISsrfDnsGuard)
          ? container.resolve<SsrfDnsGuard>(DI_TOKENS.ISsrfDnsGuard)
          : undefined;
        const http = selectIngestionHttpClient(guard, fallbackHttp);
        const validateRemoteUrl = guard
          ? (url: string) => guard.validateUrl(url)
          : undefined;
        const recorder = container.isRegistered(DI_TOKENS.IEventStore)
          && container.isRegistered(DI_TOKENS.ProposeMemoryFact)
          && container.isRegistered(DI_TOKENS.IMemoryFactStore)
          ? new PersistIngestedFacts(
            container.resolve<IEventStore>(DI_TOKENS.IEventStore),
            container.resolve<ProposeMemoryFact>(DI_TOKENS.ProposeMemoryFact),
            container.resolve<IMemoryFactStore>(DI_TOKENS.IMemoryFactStore),
          )
          : undefined;
        return new IngestionController(new ContentIngestionService(llm, pdf as never, http as never, validateRemoteUrl, recorder));
      }, {
        lifecycle: 'singleton',
        tags: ['memory', 'ingestion', 'http'],
        description: 'Multimodal memory ingestion controller; tenant comes from the API key when the request is authenticated',
      });
    }
  } catch (error) {
    console.error('✗ Failed to register memory services:', error);
    throw error;
  }
}
