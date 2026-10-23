import type { AspectConfiguration } from './AspectManager';
import { getConfig } from '../../config';

const config = getConfig();

const isLoggingEnabled = config.DISABLE_AOP_LOGGING !== 'true';
const isMetricsEnabled = config.ENABLE_AOP_METRICS !== 'false';
const isCachingEnabled = config.DISABLE_AOP_CACHING !== 'true';
const isRetryEnabled = config.DISABLE_AOP_RETRY !== 'true';
const isSecurityEnabled = config.DISABLE_AOP_SECURITY !== 'true';
const isCircuitBreakerEnabled = config.DISABLE_AOP_CIRCUIT_BREAKER !== 'true';

const aspectConfiguration: AspectConfiguration = {
  aspects: [
    {
      name: 'security',
      aspectToken: 'SecurityAspect',
      pointcut: {
        classes: ['*Controller', '*ApplicationService'],
        methods: '*',
      },
      order: 5,
      enabled: isSecurityEnabled,
    },
    {
      name: 'logging',
      aspectToken: 'LoggingAspect',
      pointcut: {
        classes: ['*Service', '*Controller', '*Adapter', '*Repository'],
        methods: '*',
      },
      order: 10,
      enabled: isLoggingEnabled,
    },
    {
      name: 'metrics',
      aspectToken: 'MetricsAspect',
      pointcut: {
        classes: ['*Service', '*Adapter', '*Repository'],
        methods: '*',
      },
      order: 20,
      enabled: isMetricsEnabled,
    },
    {
      name: 'circuitBreaker',
      aspectToken: 'CircuitBreakerAspect',
      pointcut: {
        classes: ['*Adapter', '*HttpClient', '*HSGClient', 'LLM*', 'ChatService', 'QdrantVectorClient'],
        methods: '*',
      },
      // Order is lower than Caching/Retry so that CircuitBreakerAspect
      // wraps the full execution including all retries and cache lookups.
      // Desired effective order:
      //   Security(5) → Logging(10) → Metrics(20) → CircuitBreaker(30) → Caching(40) → Retry(50).
      order: 30,
      enabled: isCircuitBreakerEnabled,
    },
    {
      name: 'caching',
      aspectToken: 'CachingAspect',
      pointcut: {
        classes: ['RateLimitService'],
        methods: '*',
      },
      order: 40,
      enabled: isCachingEnabled,
    },
    {
      name: 'retry',
      aspectToken: 'RetryAspect',
      pointcut: {
        classes: [
          '*Adapter',
          '*Repository',
          '*HttpClient',
          '*HSGClient',
          'ChatService',
          'ConversationService',
          'FileProcessingService',
          'AuthService',
          'RateLimitService',
          'FeatureFlagsService',
          'HealthCheckService',
        ],
        methods: '*',
      },
      order: 50,
      enabled: isRetryEnabled,
    },
  ],
};

export default aspectConfiguration;