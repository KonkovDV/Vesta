/**
 * Express type augmentations for MicroPhoenix
 * Extends @types/express with custom properties
 */
import 'express';

declare global {
  namespace Express {
    interface Request {
      // Add custom request properties here
      tenantId?: string;
      userId?: string;
    }
    
    interface Response {
      // Add custom response properties here
    }
  }
}

export {};