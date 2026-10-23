import type { Aspect, AroundAdviceContext } from './Aspect';
import {
  getOrCreateCounter,
  getOrCreateHistogram,
} from '../../monitoring';

export interface MetricsAspectOptions {
  counterName?: string;
  counterHelp?: string;
  histogramName?: string;
  histogramHelp?: string;
  histogramBuckets?: number[];
  labels?: (context: AroundAdviceContext, result: unknown, error: unknown) => Record<string, string>;
  observeErrors?: boolean;
}

export class MetricsAspect implements Aspect {
  private readonly counterName: string;
  private readonly histogramName: string;
  private readonly counterHelp: string;
  private readonly histogramHelp: string;
  private readonly histogramBuckets?: number[];
  private readonly labelBuilder: NonNullable<MetricsAspectOptions['labels']>;
  private readonly observeErrors: boolean;

  constructor(options: MetricsAspectOptions = {}) {
    this.counterName = options.counterName ?? 'aop_method_calls_total';
    this.counterHelp = options.counterHelp ?? 'Total number of method calls through AOP';
    this.histogramName = options.histogramName ?? 'aop_method_duration_seconds';
    this.histogramHelp = options.histogramHelp ?? 'Duration of method calls through AOP';
    this.histogramBuckets = options.histogramBuckets;
    this.labelBuilder = options.labels ?? this.defaultLabelBuilder.bind(this);
    this.observeErrors = options.observeErrors ?? true;
  }

  async around(context: AroundAdviceContext): Promise<unknown> {
    const start = process.hrtime.bigint();
    let error: unknown = undefined;
    let result: unknown = undefined;

    try {
      result = await context.proceed();
      return result;
    } catch (err) {
      error = err;
      throw err;
    } finally {
      const durationNs = process.hrtime.bigint() - start;
      const durationSeconds = Number(durationNs) / 1e9;

      const labels = this.labelBuilder(context, result, error);
      const counter = getOrCreateCounter(this.counterName, this.counterHelp, Object.keys(labels));
      counter.inc(labels);

      const histogram = getOrCreateHistogram(
        this.histogramName,
        this.histogramHelp,
        Object.keys(labels),
        this.histogramBuckets ?? [],
      );
      histogram.observe(labels, durationSeconds);

      if (error && this.observeErrors) {
        context.setAttribute('metrics:lastError', error);
      }
    }
  }

  private defaultLabelBuilder(context: AroundAdviceContext, _result: unknown, error: unknown): Record<string, string> {
    return {
      class: context.joinPoint.className,
      method: context.methodName,
      status: error ? 'error' : 'success',
    };
  }
}