/**
 * Content-Security-Policy port. The header builder lives in infrastructure.
 * Layer: Core
 */

import type * as core from 'express-serve-static-core';

export interface ICSPManager {
  generateNonce(): string;
  buildCSPHeader(req: core.Request, nonce: string): string;
  middleware(options?: { reportOnly?: boolean }): (req: core.Request, res: core.Response, next: core.NextFunction) => void;
}
