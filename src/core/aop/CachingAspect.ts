import type { ICache, CacheSetOptions } from '../../domain/cache/ICache';
import type { Aspect, AroundAdviceContext } from './Aspect';

export interface CachingAspectOptions {
  keyPrefix?: string;
  keyBuilder?: (context: AroundAdviceContext) => string | null | undefined;
  ttlSeconds?: number;
  setOptions?: CacheSetOptions;
  cacheNull?: boolean;
  bypass?: (context: AroundAdviceContext) => boolean | Promise<boolean>;
  hydrateMetadata?: boolean;
}

export class CachingAspect implements Aspect {
  private readonly cache: ICache;
  private readonly options: Required<CachingAspectOptions>;

  constructor(cache: ICache, options: CachingAspectOptions = {}) {
    this.cache = cache;
    this.options = {
      keyPrefix: options.keyPrefix ?? 'aop:cache',
      keyBuilder: options.keyBuilder ?? this.defaultKeyBuilder.bind(this),
      ttlSeconds: options.ttlSeconds ?? 300,
      setOptions: options.setOptions ?? {},
      cacheNull: options.cacheNull ?? false,
      bypass: options.bypass ?? (() => false),
      hydrateMetadata: options.hydrateMetadata ?? false,
    };
  }

  async around(context: AroundAdviceContext): Promise<unknown> {
    if (await this.options.bypass(context)) {
      return context.proceed();
    }

    const cacheKey = await Promise.resolve(this.options.keyBuilder(context));
    if (!cacheKey) {
      return context.proceed();
    }

    const fullKey = this.composeKey(cacheKey);

    try {
      const cached = await this.cache.getWithInfo<unknown>(fullKey);
      if (cached) {
        if (this.options.hydrateMetadata) {
          context.setAttribute('cache:hit', true);
          context.setAttribute('cache:cachedAt', cached.cachedAt);
          context.setAttribute('cache:ttlRemaining', cached.ttlRemainingSeconds);
        }
        return cached.value;
      }
    } catch (error) {
      context.setAttribute('cache:error', error);
    }

    const result = await context.proceed();
    if (result === null && !this.options.cacheNull) {
      return result;
    }

    const payload = result === undefined ? null : result;

    try {
      await this.cache.set(fullKey, payload, {
        ttlSeconds: this.options.ttlSeconds,
        ...this.options.setOptions,
      });
      context.setAttribute('cache:stored', true);
    } catch (error) {
      context.setAttribute('cache:storeError', error);
    }

    return result;
  }

  private composeKey(key: string): string {
    return this.options.keyPrefix ? `${this.options.keyPrefix}:${key}` : key;
  }

  private defaultKeyBuilder(context: AroundAdviceContext): string {
    const joinPoint = context.joinPoint;
    const hashedArgs = this.serializeArgs(context.args);
    return `${joinPoint.className || 'anonymous'}:${joinPoint.methodName}:${hashedArgs}`;
  }

  private serializeArgs(args: unknown[]): string {
    try {
      return JSON.stringify(args, this.replacer);
    } catch {
      return '[unserializable]';
    }
  }

  private replacer(_key: string, value: unknown): unknown {
    if (typeof value === 'function') {
      return value.name ? `[Function ${value.name}]` : '[Function]';
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
      };
    }
    return value;
  }
}