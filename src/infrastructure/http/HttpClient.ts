import * as http from 'http';
import * as https from 'https';

export interface HttpClientRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpClientResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Minimal HTTP client abstraction for infrastructure adapters.
 *
 * Infrastructure services (e.g. OpenMemoryHSGClient) should depend on this
 * interface instead of using fetch or Node http/https directly. This keeps
 * the integration testable (nock) and allows future resilience features.
 */
export interface IHttpClient {
  request(options: HttpClientRequestOptions): Promise<HttpClientResponse>;
}

export class NodeHttpJsonClient implements IHttpClient {
  async request(options: HttpClientRequestOptions): Promise<HttpClientResponse> {
    return new Promise<HttpClientResponse>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(options.url);
      } catch (error) {
        reject(error);
        return;
      }

      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const headers: Record<string, string> = {};
      const originalHeaders = options.headers;
      if (originalHeaders) {
        for (const key of Object.keys(originalHeaders)) {
          headers[key] = originalHeaders[key];
        }
      }

      let bodyString: string | undefined;
      if (options.body !== undefined) {
        if (typeof options.body === 'string') {
          bodyString = options.body;
        } else {
          bodyString = JSON.stringify(options.body);
        }

        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
        if (!headers.Accept) {
          headers.Accept = 'application/json';
        }
      }

      const request = client.request(
        {
          method: options.method,
          hostname: url.hostname,
          port: url.port ? Number(url.port) : isHttps ? 443 : 80,
          path: url.pathname + url.search,
          timeout: options.timeoutMs,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on('data', (chunk: Buffer | string) => {
            if (typeof chunk === 'string') {
              chunks.push(Buffer.from(chunk));
            } else {
              chunks.push(chunk);
            }
          });

          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const statusCode = response.statusCode ? response.statusCode : 0;
            resolve({
              statusCode,
              headers: response.headers,
              body,
            });
          });
        },
      );

      request.on('timeout', () => {
        request.destroy();
        const timeoutError = new Error(
          `HttpClient timeout after ${options.timeoutMs}ms for ${options.method} ${options.url}`,
        );
        reject(timeoutError);
      });

      request.on('error', (error) => {
        reject(error);
      });

      if (bodyString !== undefined) {
        request.write(bodyString);
      }

      request.end();
    });
  }
}