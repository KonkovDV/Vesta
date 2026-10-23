/**
 * Singularity Protocol DI Tokens
 * @version 1.1.0
 * @layer Core
 */

export const SINGULARITY_TOKENS = {
  // Layer 4: Channel Adapters
  CHANNEL_ADAPTER: Symbol.for('IChannelAdapter'),
  TELEGRAM_ADAPTER: Symbol.for('TelegramChannelAdapter'),
  SLACK_ADAPTER: Symbol.for('SlackChannelAdapter'),
  WEBSOCKET_ADAPTER: Symbol.for('WebSocketChannelAdapter'),
  WHATSAPP_ADAPTER: Symbol.for('WhatsAppChannelAdapter'),
  DISCORD_ADAPTER: Symbol.for('DiscordChannelAdapter'),
  GOOGLE_CHAT_ADAPTER: Symbol.for('GoogleChatChannelAdapter'),
  MATRIX_ADAPTER: Symbol.for('MatrixChannelAdapter'),

  // Layer 5: Context Processing
  INBOUND_CONTEXT_PROCESSOR: Symbol.for('IInboundContextProcessor'),
  CONTEXT_COMPACTOR: Symbol.for('IContextCompactor'),
  MESSAGE_VALIDATOR: Symbol.for('IMessageValidator'),
  
  // Phase 9: Context Compaction (Smart Context)
  GPT_TOKENIZER: Symbol.for('ITokenizer'),
  TOKEN_BUDGET_MANAGER: Symbol.for('ITokenBudgetManager'),
  RECURSIVE_SUMMARIZER: Symbol.for('ISummarizer'),

  // Layer 6: Identity & Security
  TAILSCALE_IDENTITY_PROVIDER: Symbol.for('ITailscaleIdentityProvider'),
  SANDBOXED_EXECUTOR: Symbol.for('ISandboxedExecutor'),
  AUTH_MIDDLEWARE: Symbol.for('IAuthMiddleware'),

  // Layer 7: Agent Runtime
  AGENT_WORKER: Symbol.for('IAgentWorker'),
  AGENT_RUNNER: Symbol.for('AgentRunner'),
  TASK_QUEUE: Symbol.for('ITaskQueue'),

  // Layer 8: Resilience
  CIRCUIT_BREAKER: Symbol.for('ICircuitBreaker'),
  LLM_CIRCUIT_BREAKER: Symbol.for('LLMCircuitBreaker'),
  DB_CIRCUIT_BREAKER: Symbol.for('DBCircuitBreaker'),

  // Layer 8: Discovery
  SERVICE_REGISTRY: Symbol.for('IServiceRegistry'),
  REDLOCK_MANAGER: Symbol.for('IRedlockManager'),

  // Infrastructure
  BROWSER_SERVER: Symbol.for('IBrowserServer'),
  CONTAINER_RUNTIME: Symbol.for('IContainerRuntime'),

  // Layer 9: Memory Infrastructure (Phase 5)
  THOUGHT_REPOSITORY: Symbol.for('IThoughtRepository'),
  DREAM_STATE_REPOSITORY: Symbol.for('IDreamStateRepository'),
} as const;

export type SingularityToken = typeof SINGULARITY_TOKENS[keyof typeof SINGULARITY_TOKENS];

export const TOKEN_CATEGORIES = {
  CHANNEL_ADAPTERS: [
    SINGULARITY_TOKENS.CHANNEL_ADAPTER,
    SINGULARITY_TOKENS.TELEGRAM_ADAPTER,
    SINGULARITY_TOKENS.SLACK_ADAPTER,
    SINGULARITY_TOKENS.WEBSOCKET_ADAPTER,
    SINGULARITY_TOKENS.WHATSAPP_ADAPTER,
    SINGULARITY_TOKENS.DISCORD_ADAPTER,
  ],
  CONTEXT_PROCESSING: [
    SINGULARITY_TOKENS.INBOUND_CONTEXT_PROCESSOR,
    SINGULARITY_TOKENS.CONTEXT_COMPACTOR,
    SINGULARITY_TOKENS.MESSAGE_VALIDATOR,
  ],
  IDENTITY_SECURITY: [
    SINGULARITY_TOKENS.TAILSCALE_IDENTITY_PROVIDER,
    SINGULARITY_TOKENS.SANDBOXED_EXECUTOR,
    SINGULARITY_TOKENS.AUTH_MIDDLEWARE,
  ],
  AGENT_RUNTIME: [
    SINGULARITY_TOKENS.AGENT_WORKER,
    SINGULARITY_TOKENS.AGENT_RUNNER,
    SINGULARITY_TOKENS.TASK_QUEUE,
  ],
  RESILIENCE: [
    SINGULARITY_TOKENS.CIRCUIT_BREAKER,
    SINGULARITY_TOKENS.LLM_CIRCUIT_BREAKER,
    SINGULARITY_TOKENS.DB_CIRCUIT_BREAKER,
    SINGULARITY_TOKENS.SERVICE_REGISTRY,
    SINGULARITY_TOKENS.REDLOCK_MANAGER,
  ],
} as const;
