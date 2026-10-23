/**
 * Minimal Express + Multer typings used across the app.
 * This module provides just enough shape for Request/Response/NextFunction
 * so that controllers (chatController, feature-flags HTTP API, etc.)
 * can rely on express-based types without pulling full @types/express.
 *
 * NOTE: This file AUGMENTS @types/express, it does not replace it.
 * The import statement below ensures TypeScript treats this as an augmentation.
 */

// Multer-related types
declare namespace Express {
  interface Multer {
    single(fieldname: string): any;
    array(fieldname: string, maxCount?: number): any;
    fields(fields: Array<{ name: string; maxCount?: number }>): any;
    any(): any;
    none(): any;
  }

  namespace multer {
    interface File {
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      size: number;
      destination: string;
      filename: string;
      path: string;
      buffer: Buffer;
    }
  }
}

// Import to make this an augmentation, not a replacement
import 'express';

declare module 'express' {
  // Extend Request with Multer file fields
  interface Request {
    file?: Express.multer.File;
    files?: Express.multer.File[] | { [fieldname: string]: Express.multer.File[] };
  }
}