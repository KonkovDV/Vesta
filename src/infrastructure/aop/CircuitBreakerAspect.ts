import type { Aspect, AroundAdviceContext } from '../../core/aop/Aspect';
import type {
  CircuitBreakerKey,
  CircuitBreakerChannel,
} from '../../core/resilience/CircuitBreakerKey';
import type { ICircuitBreakerRegistry } from '../../core/resilience/ICircuitBreakerRegistry';
import type { CircuitBreakerConfig } from '../../core/resilience/CircuitBreakerConfig';

export interface CircuitBreakerAspectOptions {
  /**
   * Logical environment label (dev/stage/prod/test).
   */
  environment: string;

  /**
   * Optional default channel used when no more specific
   * channel can be derived from join point metadata.
   */
  defaultChannel?: CircuitBreakerChannel;

  /**
   * Optional static config override applied for every breaker
   * created via this aspect. This is a coarse-grained hook;
   * fine-grained profiles are handled by ICircuitBreakerRegistry.
   */
  defaultConfigOverride?: Partial<CircuitBreakerConfig>;

  /**
   * Optional hook to resolve tenantId for metrics/keys.
   */
  tenantIdResolver?: (context: AroundAdviceContext) => string | undefined;
}

export class CircuitBreakerAspect implements Aspect {
  constructor(
    private readonly registry: ICircuitBreakerRegistry,
    private readonly options: CircuitBreakerAspectOptions,
  ) {}

  async around(context: AroundAdviceContext): Promise<unknown> {
    const key = this.buildKey(context);
    const breaker = this.registry.getBreaker(key, this.options.defaultConfigOverride);

    const timeoutMs = this.extractTimeoutMs(context);

    const result = await breaker.execute(
      async () => context.proceed(),
      timeoutMs ? { timeoutMs } : undefined,
    );

    if (result.success) {
      return result.data;
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(
      `CircuitBreakerAspect: operation failed for ${key.serviceName}.${key.operation} without error instance`,
    );
  }

  private buildKey(context: AroundAdviceContext): CircuitBreakerKey {
    const channel = this.resolveChannel(context);
    const serviceName = this.resolveServiceName(context);
    const operation = context.methodName ?? 'unknownMethod';
    const tenantId =
      this.options.tenantIdResolver?.(context) ?? this.resolveTenantIdFromMetadata(context);

    const extraTags: Record<string, string> = {};

    const annotations = context.joinPoint.annotations;
    if (annotations && annotations.length > 0) {
      extraTags.annotations = annotations.join(',');
    }

    const metadata = context.joinPoint.metadata;
    if (metadata && typeof metadata === 'object') {
      const rawIntegration = (metadata as { integrationName?: unknown }).integrationName;
      if (typeof rawIntegration === 'string' && rawIntegration.length > 0) {
        extraTags.integration = rawIntegration;
      }
    }

    return {
      channel,
      serviceName,
      operation,
      environment: this.options.environment,
      tenantId,
      extraTags: Object.keys(extraTags).length > 0 ? extraTags : undefined,
    };
  }

  private resolveChannel(context: AroundAdviceContext): CircuitBreakerChannel {
    const className = context.joinPoint.className ?? '';

    const annotations = context.joinPoint.annotations ?? [];
    if (annotations.includes('llm')) {
      return 'LLM';
    }
    if (annotations.includes('memory')) {
      return 'MEMORY';
    }
    if (annotations.includes('http')) {
      return 'HTTP';
    }

    if (/(LLM|OpenAI|Claude|Anthropic)/i.test(className)) {
      return 'LLM';
    }

    if (/(HSG|Memory)/i.test(className)) {
      return 'MEMORY';
    }

    if (/(HttpClient|Client|Fetch|Request)/i.test(className)) {
      return 'HTTP';
    }

    return this.options.defaultChannel ?? 'OTHER';
  }

  private resolveServiceName(context: AroundAdviceContext): string {
    const className = context.joinPoint.className ?? 'UnknownService';

    if (className.endsWith('Adapter')) {
      return className.replace(/Adapter$/, '');
    }

    return className;
  }

  private resolveTenantIdFromMetadata(
    context: AroundAdviceContext,
  ): string | undefined {
    const attributes = context.metadata.attributes;
    if (!attributes) {
      return undefined;
    }

    const fromCtx = attributes.get('request:tenantId');
    if (typeof fromCtx === 'string' && fromCtx.length > 0) {
      return fromCtx;
    }

    return undefined;
  }

  private extractTimeoutMs(context: AroundAdviceContext): number | undefined {
    const args = context.args;

    if (!args || args.length === 0) {
      return undefined;
    }

    const lastArg = args[args.length - 1];

    if (lastArg && typeof lastArg === 'object') {
      const candidate = (lastArg as { timeoutMs?: unknown }).timeoutMs;
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return candidate;
      }
    }

    return undefined;
  }
}