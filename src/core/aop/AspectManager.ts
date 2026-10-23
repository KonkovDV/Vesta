import type { DIContainer } from '../di/container';
import {
  Aspect,
  AdviceContext,
  AroundAdviceContext,
  AspectRegistration,
  JoinPointMetadata,
  PointcutExpression,
  PointcutMatcher,
  ProceedFunction,
  createAdviceContext,
  createInvocationMetadata,
  compilePointcut,
} from './Aspect';

export interface RegisterAspectOptions {
  aspectToken: string | symbol;
  pointcut: PointcutExpression | PointcutMatcher;
  order?: number;
  enabled?: boolean;
  name?: string;
  conditions?: Array<(joinPoint: JoinPointMetadata) => boolean>;
}

export interface AspectConfiguration {
  aspects: Array<{
    name: string;
    aspectToken: string;
    pointcut: {
      classes: string[];
      methods: string;
    };
    order: number;
    enabled: boolean;
  }>;
}

export interface MethodAspectOptions {
  tags?: string[];
  annotations?: string[];
  metadata?: Record<string, unknown>;
}

export interface ApplyAspectsOptions {
  className?: string;
  modulePath?: string;
  tags?: string[];
  annotations?: string[];
  metadata?: Record<string, unknown>;
  methodMetadata?: Record<string, MethodAspectOptions>;
  skipMethods?: (methodName: string | symbol) => boolean;
  disableProxyCache?: boolean;
}

type InternalRegistration = AspectRegistration & {
  matcher: PointcutMatcher;
  originalPointcut?: PointcutExpression;
};

interface AppliedAspect {
  registration: AspectRegistration;
  matcher: PointcutMatcher;
  aspect: Aspect;
}

const SKIP_METHODS = new Set<PropertyKey>(['constructor']);

export class AspectManager {
  /**
   * Services excluded from AOP wrapping to prevent proxy delegation issues.
   * These services are returned unwrapped from applyTo().
   */
  private static readonly SERVICE_EXCLUSIONS = new Set<string>([
    'FeatureFlagsService',
    'ConfigLoader',
    'StructuredLogger',
    'FeatureStrategyRegistry',
    'InMemoryEventBus',
    'InMemoryOutbox',
    'NoOpMetricsAdapter',
    'PrometheusMetricsAdapter',
  ]);

  private readonly registrations: InternalRegistration[] = [];
  private readonly proxyCache = new WeakMap<object, unknown>();
  private readonly methodWrapperCache = new WeakMap<object, Map<PropertyKey, Function>>();
  private readonly joinPointCache = new Map<string, AppliedAspect[]>();

  constructor(private readonly container: DIContainer) {}

  registerAspect(options: RegisterAspectOptions): void {
    const {
      aspectToken,
      pointcut,
      order = 0,
      enabled = true,
      name,
      conditions = [],
    } = options;

    const matcher: PointcutMatcher =
      typeof (pointcut as PointcutMatcher)?.matches === 'function'
        ? (pointcut as PointcutMatcher)
        : compilePointcut(pointcut as PointcutExpression);

    const registration: InternalRegistration = {
      aspectToken,
      matcher,
      order,
      enabled,
      name,
      conditions,
      pointcut: matcher, // Используем скомпилированный matcher
      originalPointcut: typeof pointcut === 'string' ? pointcut : undefined,
    };

    this.registrations.push(registration);
    // Соблюдаем порядок применения (меньшее значение order выполняется раньше)
    this.registrations.sort((a, b) => a.order - b.order);
    this.joinPointCache.clear();
  }

  hasAspects(): boolean {
    return this.registrations.length > 0;
  }

  applyTo<T extends object>(instance: T, options: ApplyAspectsOptions = {}): T {
    if (!this.hasAspects()) {
      return instance;
    }

    if (typeof instance !== 'object' || instance === null) {
      return instance;
    }

    // Check if service is in exclusion list
    const className = instance.constructor?.name;
    if (className && AspectManager.SERVICE_EXCLUSIONS.has(className)) {
      return instance; // Return unwrapped
    }

    // Если это уже прокси, возвращаем как есть
    if (this.proxyCache.has(instance)) {
      return this.proxyCache.get(instance) as T;
    }

    const methodCache = new Map<PropertyKey, Function>();
    this.methodWrapperCache.set(instance, methodCache);

    const handler: ProxyHandler<T> = {
      get: (target, property, receiver) => {
        const originalValue = Reflect.get(target, property, receiver);

        if (typeof originalValue !== 'function' || SKIP_METHODS.has(property)) {
          return originalValue;
        }

        if (options.skipMethods && options.skipMethods(property)) {
          return originalValue.bind(receiver);
        }

        const cached = methodCache.get(property);
        if (cached) {
          return cached;
        }

        const wrapper = this.createMethodWrapper(
          instance,
          property,
          originalValue as (...args: unknown[]) => unknown,
          options,
          receiver,
        );

        methodCache.set(property, wrapper);
        return wrapper;
      },
    };

    const proxy = new Proxy<T>(instance, handler);

    if (!options.disableProxyCache) {
      this.proxyCache.set(instance, proxy);
    }

    return proxy;
  }

  private createMethodWrapper(
    targetInstance: object,
    property: PropertyKey,
    originalMethod: (...args: unknown[]) => unknown,
    options: ApplyAspectsOptions,
    proxyReceiver: unknown,
  ): (...args: unknown[]) => unknown {
    const methodName = typeof property === 'string' ? property : property.toString();

    const joinPointBase: JoinPointMetadata = {
      className: options.className ?? targetInstance.constructor?.name ?? 'AnonymousClass',
      methodName,
      modulePath: options.modulePath,
      tags: options.tags,
      annotations: options.annotations,
      metadata: options.metadata,
    };

    const perMethodOptions = options.methodMetadata?.[methodName];

    const wrapper = (...args: unknown[]) => {
      const actualThis = this.resolveThisArg(this, proxyReceiver, targetInstance, thisArg());
      const joinPoint = this.buildJoinPoint(
        actualThis,
        methodName,
        joinPointBase,
        perMethodOptions,
      );

      const applicable = this.getApplicableAspects(joinPoint);

      if (!applicable.length) {
        return originalMethod.apply(actualThis, args);
      }

      // Aspects matched — async execution with advice chain
      return (async () => {
        const metadata = createInvocationMetadata(joinPoint, this.container);
        const baseContext = createAdviceContext(actualThis, methodName, args, metadata);

        const proceedOriginal: ProceedFunction = async () =>
          originalMethod.apply(targetInstance, baseContext.args);

        const aroundChain = this.composeAround(applicable, baseContext, proceedOriginal);
        try {
          await this.runBefore(applicable, baseContext);
          const result = await aroundChain();
          await this.runAfter(applicable, baseContext, result);
          return result;
        } catch (error) {
          await this.runAfterThrow(applicable, baseContext, error);
          throw error;
        }
      })();
    };

    const boundWrapper = wrapper.bind(proxyReceiver as object);

    return boundWrapper;

    /* istanbul ignore next — env-dependent: [native code] stack detection unreachable in tests */
    function thisArg() {
      /* istanbul ignore next */
      return new Error().stack?.includes('[native code]') ? targetInstance : undefined;
    }
  }

  private resolveThisArg(
    manager: AspectManager,
    proxyReceiver: unknown,
    fallback: object,
    stackLookup?: object,
  ): object {
    /* istanbul ignore next — env-dependent: only reachable when Error.stack includes [native code] */
    if (stackLookup && typeof stackLookup === 'object') {
      return stackLookup;
    }

    /* istanbul ignore next — defensive: proxyReceiver is always the Proxy object (truthy) */
    if (proxyReceiver && typeof proxyReceiver === 'object') {
      /* istanbul ignore next — defensive: proxy reference is never stored as a proxyCache key */
      if (manager.proxyCache.has(proxyReceiver)) {
        return fallback;
      }
      return proxyReceiver;
    }

    /* istanbul ignore next — defensive: Proxy get trap always provides a truthy receiver */
    return fallback;
  }

  private buildJoinPoint(
    instance: object,
    methodName: string,
    base: JoinPointMetadata,
    methodOptions?: MethodAspectOptions,
  ): JoinPointMetadata {
    const tags = new Set<string>();
    const annotations = new Set<string>();

    (base.tags ?? []).forEach(tag => tags.add(tag));
    (methodOptions?.tags ?? []).forEach(tag => tags.add(tag));

    (base.annotations ?? []).forEach(annotation => annotations.add(annotation));
    (methodOptions?.annotations ?? []).forEach(annotation => annotations.add(annotation));

    const metadata = {
      ...(base.metadata ?? {}),
      ...(methodOptions?.metadata ?? {}),
    };

    return {
      className: instance.constructor?.name ?? base.className,
      methodName,
      modulePath: base.modulePath,
      tags: tags.size ? Array.from(tags) : undefined,
      annotations: annotations.size ? Array.from(annotations) : undefined,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    };
  }

  private getApplicableAspects(joinPoint: JoinPointMetadata): AppliedAspect[] {
    const cacheKey = this.buildCacheKey(joinPoint);
    const cached = this.joinPointCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const resolved: AppliedAspect[] = [];

    for (const registration of this.registrations) {
      if (!registration.enabled) continue;
      if (!registration.matcher.matches(joinPoint)) continue;

      if (
        registration.conditions &&
        !registration.conditions.every(condition => {
          try {
            return condition(joinPoint);
          } catch {
            return false;
          }
        })
      ) {
        continue;
      }

      const aspectInstance = this.resolveAspectInstance(registration.aspectToken);
      if (!aspectInstance) continue;

      resolved.push({
        registration,
        matcher: registration.matcher,
        aspect: aspectInstance,
      });
    }

    const sorted = resolved.sort(
      (a, b) => a.registration.order - b.registration.order,
    );

    this.joinPointCache.set(cacheKey, sorted);
    return sorted;
  }

  private resolveAspectInstance(token: string | symbol): Aspect | null {
    try {
      return this.container.resolve<Aspect>(token);
    } catch (error) {
       
      console.error(`[AspectManager] Failed to resolve aspect "${String(token)}":`, error);
      return null;
    }
  }

  private composeAround(
    aspects: AppliedAspect[],
    baseContext: AdviceContext,
    proceedOriginal: ProceedFunction,
  ): ProceedFunction {
    let next: ProceedFunction = proceedOriginal;

    for (let i = aspects.length - 1; i >= 0; i--) {
      const aspect = aspects[i].aspect;
      if (typeof aspect.around !== 'function') {
        continue;
      }

      const around = aspect.around.bind(aspect);
      const currentNext = next;

      next = async () => {
        const context = this.createAroundContext(baseContext, currentNext, proceedOriginal);
        return around(context);
      };
    }

    return async () => next();
  }

  private async runBefore(
    aspects: AppliedAspect[],
    baseContext: AdviceContext,
  ): Promise<void> {
    for (const { aspect } of aspects) {
      if (typeof aspect.before !== 'function') continue;

      const context = this.createDerivedContext(baseContext);
      await aspect.before(context);
    }
  }

  private async runAfter(
    aspects: AppliedAspect[],
    baseContext: AdviceContext,
    result: unknown,
  ): Promise<void> {
    for (let i = aspects.length - 1; i >= 0; i--) {
      const aspect = aspects[i].aspect;
      if (typeof aspect.after !== 'function') continue;

      const context = this.createDerivedContext(baseContext);
      await aspect.after(context, result);
    }
  }

  private async runAfterThrow(
    aspects: AppliedAspect[],
    baseContext: AdviceContext,
    error: unknown,
  ): Promise<void> {
    for (let i = aspects.length - 1; i >= 0; i--) {
      const aspect = aspects[i].aspect;
      if (typeof aspect.afterThrow !== 'function') continue;

      const context = this.createDerivedContext(baseContext);
      try {
        await aspect.afterThrow(context, error);
      } catch (hookError) {
        // @audit-ok: Core layer, no DI — error handler in afterThrow hook
        console.error('[AspectManager] afterThrow hook failed:', hookError);
      }
    }
  }

  private createAroundContext(
    baseContext: AdviceContext,
    proceed: ProceedFunction,
    proceedOriginal: ProceedFunction,
  ): AroundAdviceContext {
    const derived = this.createDerivedContext(baseContext);
    return {
      ...derived,
      proceed: async () => proceed(),
      proceedOriginal: async () => proceedOriginal(),
    };
  }

  private createDerivedContext(baseContext: AdviceContext): AdviceContext {
    return {
      target: baseContext.target,
      methodName: baseContext.methodName,
      get args(): unknown[] {
        return baseContext.args;
      },
      set args(value: unknown[]) {
        baseContext.args = value;
      },
      metadata: baseContext.metadata,
      container: baseContext.container,
      joinPoint: baseContext.joinPoint,
      setAttribute: baseContext.setAttribute,
      getAttribute: baseContext.getAttribute,
    };
  }

  private buildCacheKey(joinPoint: JoinPointMetadata): string {
    const base = `${joinPoint.className}::${joinPoint.methodName}`;
    const module = joinPoint.modulePath ?? '';
    const tags = joinPoint.tags?.join('|') ?? '';
    const annotations = joinPoint.annotations?.join('|') ?? '';
    const metadata = joinPoint.metadata;
    const metadataKeys = metadata
      ? Object.keys(metadata)
          .sort()
          .map(key => `${key}:${this.stringifyMetadata(metadata[key])}`)
          .join('|')
      : '';

    return [base, module, tags, annotations, metadataKeys].join('##');
  }

  private stringifyMetadata(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}