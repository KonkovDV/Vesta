import type { DIContainer } from '../di/container';

export type ProceedFunction = () => Promise<unknown>;

export interface JoinPointMetadata {
  className: string;
  methodName: string;
  modulePath?: string;
  tags?: string[];
  annotations?: string[];
  metadata?: Record<string, unknown>;
}

export interface InvocationMetadata {
  readonly joinPoint: JoinPointMetadata;
  readonly container: DIContainer;
  readonly attributes: Map<string, unknown>;
}

export interface AdviceContext {
  readonly target: object;
  readonly methodName: string;
  args: unknown[];
  readonly metadata: InvocationMetadata;
  readonly container: DIContainer;
  readonly joinPoint: JoinPointMetadata;
  setAttribute: (key: string, value: unknown) => void;
  getAttribute: <T = unknown>(key: string) => T | undefined;
}

export interface AroundAdviceContext extends AdviceContext {
  readonly proceed: ProceedFunction;
  readonly proceedOriginal: ProceedFunction;
}

export abstract class Aspect {
  before?(context: AdviceContext): void | Promise<void>;
  after?(context: AdviceContext, result: unknown): void | Promise<void>;
  afterThrow?(context: AdviceContext, error: unknown): void | Promise<void>;
  around?(context: AroundAdviceContext): unknown | Promise<unknown>;
}

export type PointcutExpression =
  | string
  | RegExp
  | PointcutDefinition
  | ((joinPoint: JoinPointMetadata) => boolean);

export interface PointcutDefinition {
  classes?: PatternInput;
  methods?: PatternInput;
  modulePaths?: PatternInput;
  tags?: PatternInput;
  annotations?: PatternInput;
  metadata?: Record<string, MetadataMatcher>;
  predicate?: (joinPoint: JoinPointMetadata) => boolean;
}

export type PatternInput = string | RegExp | Array<string | RegExp>;

export type MetadataMatcher =
  | unknown
  | RegExp
  | ((value: unknown, joinPoint: JoinPointMetadata) => boolean);

export interface PointcutMatcher {
  matches(joinPoint: JoinPointMetadata): boolean;
}

export interface AspectRegistration {
  readonly aspectToken: string | symbol;
  readonly pointcut: PointcutMatcher;
  readonly order: number;
  readonly enabled: boolean;
  readonly name?: string;
  readonly conditions?: Array<(joinPoint: JoinPointMetadata) => boolean>;
}

export function createInvocationMetadata(
  joinPoint: JoinPointMetadata,
  container: DIContainer,
): InvocationMetadata {
  return {
    joinPoint,
    container,
    attributes: new Map<string, unknown>(),
  };
}

export function createAdviceContext(
  target: object,
  methodName: string,
  args: unknown[],
  metadata: InvocationMetadata,
): AdviceContext {
  return {
    target,
    methodName,
    args,
    metadata,
    container: metadata.container,
    joinPoint: metadata.joinPoint,
    setAttribute: (key: string, value: unknown) => {
      metadata.attributes.set(key, value);
    },
    getAttribute: <T = unknown>(key: string): T | undefined => {
      return metadata.attributes.get(key) as T | undefined;
    },
  };
}

export function compilePointcut(expression: PointcutExpression): PointcutMatcher {
  if (typeof expression === 'function') {
    return { matches: expression };
  }

  if (expression instanceof RegExp || typeof expression === 'string') {
    const matcher = createPatternMatcher(expression);
    return {
      matches(joinPoint: JoinPointMetadata) {
        return matcher(joinPoint.className) || matcher(joinPoint.methodName);
      },
    };
  }

  const def: PointcutDefinition = Array.isArray(expression) || typeof expression === 'string'
    ? { methods: expression as PatternInput }
    : expression;

  const classMatcher = def.classes ? createComplexMatcher(def.classes) : undefined;
  const methodMatcher = def.methods ? createComplexMatcher(def.methods) : undefined;
  const moduleMatcher = def.modulePaths ? createComplexMatcher(def.modulePaths) : undefined;
  const tagsMatcher = def.tags ? createArrayMatcher(def.tags) : undefined;
  const annotationsMatcher = def.annotations ? createArrayMatcher(def.annotations) : undefined;
  const metadataMatcher = def.metadata ? createMetadataMatcher(def.metadata) : undefined;
  const predicate = def.predicate;

  return {
    matches(joinPoint: JoinPointMetadata) {
      if (classMatcher && !classMatcher(joinPoint.className)) {
        return false;
      }

      if (methodMatcher && !methodMatcher(joinPoint.methodName)) {
        return false;
      }

      if (moduleMatcher && !moduleMatcher(joinPoint.modulePath ?? '')) {
        return false;
      }

      if (tagsMatcher && !tagsMatcher(joinPoint.tags ?? [])) {
        return false;
      }

      if (annotationsMatcher && !annotationsMatcher(joinPoint.annotations ?? [])) {
        return false;
      }

      if (metadataMatcher && !metadataMatcher(joinPoint.metadata ?? {}, joinPoint)) {
        return false;
      }

      if (predicate && !predicate(joinPoint)) {
        return false;
      }

      return true;
    },
  };
}

function createComplexMatcher(patterns: PatternInput): (value: string) => boolean {
  const matchers = Array.isArray(patterns) ? patterns : [patterns];
  const compiled = matchers.map(createPatternMatcher);

  return (value: string) => compiled.some(matcher => matcher(value));
}

function createArrayMatcher(patterns: PatternInput): (values: string[]) => boolean {
  const matcher = createComplexMatcher(patterns);
  return (values: string[]) => values.some(value => matcher(value));
}

function createMetadataMatcher(
  shape: Record<string, MetadataMatcher>,
): (metadata: Record<string, unknown>, joinPoint: JoinPointMetadata) => boolean {
  return (metadata: Record<string, unknown>, joinPoint: JoinPointMetadata) => {
    return Object.entries(shape).every(([key, expected]) => {
      const actual = metadata[key];
      if (expected instanceof RegExp) {
        return typeof actual === 'string' && expected.test(actual);
      }
      if (typeof expected === 'function') {
        return expected(actual, joinPoint);
      }
      return expected === actual;
    });
  };
}

function createPatternMatcher(pattern: string | RegExp): (value: string) => boolean {
  if (pattern instanceof RegExp) {
    return value => pattern.test(value);
  }

  const trimmed = pattern.trim();
  if (trimmed === '*') {
    return () => true;
  }

  const regex = globToRegExp(trimmed);
  return value => regex.test(value);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
    .replace(/\*\*/g, '§§DOUBLE_WILDCARD§§')
    .replace(/\*/g, '[^:.]*')
    .replace(/§§DOUBLE_WILDCARD§§/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${escaped}$`, 'i');
}