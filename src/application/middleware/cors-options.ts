import type cors from 'cors';

const DEFAULT_METHODS = 'GET,POST,PUT,DELETE,OPTIONS';
const DEFAULT_HEADERS =
  'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key, Cache-Control, X-Correlation-Id';

export interface ApplicationCorsInput {
  rawOrigins?: string;
  methodsRaw?: string;
  headersRaw?: string;
  onReject?: (origin: string, allowedOrigins: string[]) => void;
}

/**
 * Wildcard origins cannot be combined with credentialed CORS.
 * Browsers reject `Access-Control-Allow-Origin: *` together with credentials,
 * and reflecting every origin with credentials would trust any site.
 */
export function buildApplicationCorsOptions(input: ApplicationCorsInput = {}): cors.CorsOptions {
  const rawOrigins = input.rawOrigins ?? '';
  const allowAll = rawOrigins.trim() === '*';
  const allowedOrigins = rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== '*');
  const methodsRaw = input.methodsRaw ?? DEFAULT_METHODS;
  const headersRaw = input.headersRaw ?? DEFAULT_HEADERS;

  return {
    origin: (origin, callback) => {
      if (!origin || allowAll || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      input.onReject?.(origin, allowedOrigins);
      callback(null, false);
    },
    methods: methodsRaw
      .split(',')
      .map((method) => method.trim().toUpperCase())
      .filter((method) => method.length > 0),
    allowedHeaders: headersRaw
      .split(',')
      .map((header) => header.trim())
      .filter((header) => header.length > 0),
    credentials: !allowAll,
    maxAge: 600,
  };
}
