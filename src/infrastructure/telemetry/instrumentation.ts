/**
 * OpenTelemetry Instrumentation Bootstrap
 * Layer: Infrastructure
 *
 * Initializes the OpenTelemetry SDK with OTLP exporters and auto-instrumentation.
 * Load via `--require ./dist/infrastructure/telemetry/instrumentation.js`
 * or call `initTelemetry()` from the entry point before app bootstrap.
 *
 * Packages required (now installed):
 *   @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
 *   @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http
 *   @opentelemetry/api @opentelemetry/resources @opentelemetry/semantic-conventions
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes, defaultResource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

let initialized = false;
let sdkInstance: NodeSDK | undefined;

export interface TelemetryConfig {
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  otlpEndpoint?: string;
  enabled?: boolean;
  metricsIntervalMs?: number;
}

/**
 * Initialize OpenTelemetry tracing and metrics.
 * Safe to call multiple times — only the first call has effect.
 * MUST be called before any other imports (Express, pg, ioredis) for
 * auto-instrumentation to patch correctly.
 */
export async function initTelemetry(config?: TelemetryConfig): Promise<void> {
  if (initialized) return;

  const enabled = config?.enabled ?? (process.env['OTEL_ENABLED'] === 'true');
  if (!enabled) {
    initialized = true;
    return;
  }

  const serviceName = config?.serviceName
    ?? process.env['OTEL_SERVICE_NAME']
    ?? 'microphoenix';

  const serviceVersion = config?.serviceVersion
    ?? process.env['OTEL_SERVICE_VERSION']
    ?? '2.9.0';

  const environment = config?.environment
    ?? process.env['NODE_ENV']
    ?? 'development';

  const otlpEndpoint = config?.otlpEndpoint
    ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
    ?? 'http://localhost:4318';

  const metricsIntervalMs = config?.metricsIntervalMs ?? 30_000;

  try {
    const resource = defaultResource().merge(resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
    }));

    const traceExporter = new OTLPTraceExporter({
      url: `${otlpEndpoint}/v1/traces`,
    });

    const metricExporter = new OTLPMetricExporter({
      url: `${otlpEndpoint}/v1/metrics`,
    });

    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: metricsIntervalMs,
    });

    const sdk = new NodeSDK({
      resource,
      traceExporter,
      metricReaders: [metricReader],
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable fs instrumentation (noisy) and keep http, pg, ioredis, express
          '@opentelemetry/instrumentation-fs': { enabled: false },
          // Pino instrumentation: auto-injects trace_id, span_id, trace_flags
          // into log records for Grafana Loki / ELK trace↔log correlation
          '@opentelemetry/instrumentation-pino': { enabled: true },
        }),
      ],
    });

    sdk.start();
    sdkInstance = sdk;
    initialized = true;

    // Graceful shutdown — flush pending spans/metrics
    const shutdown = (): void => {
      sdk.shutdown().catch(() => { /* swallow — process is exiting */ });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch {
    // OTel initialization failed — log warning but don't block app startup
    console.warn('[OTel] Failed to initialize OpenTelemetry — continuing without tracing');
    initialized = true;
  }
}

/**
 * Gracefully shut down the OTel SDK (flush remaining telemetry).
 * Called during application shutdown sequence.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdkInstance) {
    await sdkInstance.shutdown();
    sdkInstance = undefined;
  }
}
