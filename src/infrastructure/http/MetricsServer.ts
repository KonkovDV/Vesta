/**
 * MetricsServer — Dedicated HTTP server for Prometheus /metrics endpoint.
 *
 * CNCF Best Practice: Serve metrics on a separate port (default 9090) to:
 * 1. Isolate scrape traffic from application traffic
 * 2. Allow NetworkPolicy to restrict metrics access to monitoring namespace only
 * 3. Prevent metrics scraping from consuming application connection pool
 *
 * References:
 *  - Prometheus Best Practices: https://prometheus.io/docs/instrumenting/writing_exporters/
 *  - CNCF TAG Observability Whitepaper 2024 §3.2
 *  - Grafana Agent Remote Write: separate port prevents scrape-induced latency
 */
import http from 'http';
import { getRegistry, getOverallHealth } from '../../monitoring';
import { readStr } from '../../core/config/app-config';
import { timingSafeEqual } from 'crypto';

const DEFAULT_METRICS_PORT = 9090;

export class MetricsServer {
  private server: http.Server | null = null;
  private readonly port: number;

  constructor(port?: number) {
    const configPort = parseInt(readStr('METRICS_PORT', '') ?? '', 10);
    this.port = port ?? (Number.isFinite(configPort) ? configPort : DEFAULT_METRICS_PORT);
  }

  async start(): Promise<number> {
    if (this.server) {
      throw new Error('[MetricsServer] Already started');
    }

    return new Promise<number>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        // Only accept GET /metrics
        if (req.method === 'GET' && (req.url === '/metrics' || req.url?.startsWith('/metrics?'))) {
          // Bearer token auth (same as main app — ACA-014)
          const metricsToken = readStr('METRICS_AUTH_TOKEN', '');
          if (metricsToken) {
            const authHeader = req.headers.authorization ?? '';
            const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
            const expected = Buffer.from(metricsToken);
            const provided = Buffer.from(providedToken);
            if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
              res.writeHead(401, { 'Content-Type': 'text/plain' });
              res.end('metrics_unauthorized');
              return;
            }
          }

          try {
            const registry = getRegistry();
            const metrics = await registry.metrics();
            const registryWithContentType = registry as { contentType?: string };
            const contentType = registryWithContentType.contentType || 'text/plain; version=0.0.4';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(metrics);
          } catch {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('metrics_error');
          }
          return;
        }

        // Health endpoint for the metrics server itself
        if (req.method === 'GET' && req.url === '/healthz') {
          try {
            const status = await getOverallHealth();
            res.writeHead(status.ok ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status));
          } catch {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('healthz_error');
          }
          return;
        }

        // 404 for anything else
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not_found');
      });

      // Slowloris protection
      server.headersTimeout = 10_000;
      server.requestTimeout = 30_000;

      server.once('error', (err) => {
        this.server = null;
        reject(err);
      });

      server.listen(this.port, '0.0.0.0', () => {
        server.removeAllListeners('error');
        this.server = server;
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        console.log(`[MetricsServer] Listening on port ${actualPort}`);
        resolve(actualPort);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
    console.log('[MetricsServer] Stopped');
  }

  isRunning(): boolean {
    return this.server !== null;
  }
}
