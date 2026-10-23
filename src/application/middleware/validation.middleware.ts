
import type { Request, Response, NextFunction } from 'express-serve-static-core';
import type { IFirewallService } from '../../domain/security/firewall.port';

type RequestValue = Record<string, unknown> | unknown[] | string | number | boolean | null | undefined;

interface ParseSchema<TInput = unknown, TOutput = unknown> {
  parse(input: TInput): TOutput;
}

interface ValidateResult<TOutput> {
  error?: unknown;
  value: TOutput;
}

interface ValidateSchema<TInput = unknown, TOutput = unknown> {
  validate(input: TInput): ValidateResult<TOutput>;
}

type BodySchema<TOutput> = ParseSchema<unknown, TOutput> | ValidateSchema<unknown, TOutput>;
type QuerySchema<TOutput> = ParseSchema<Request['query'], TOutput> | ValidateSchema<Request['query'], TOutput>;
type ParamsSchema<TOutput> = ParseSchema<Request['params'], TOutput> | ValidateSchema<Request['params'], TOutput>;

interface RequestValidationSchemas<TBody = unknown, TQuery = unknown, TParams = unknown> {
  body?: BodySchema<TBody>;
  query?: QuerySchema<TQuery>;
  params?: ParamsSchema<TParams>;
}

interface ValidationCarrier {
  validatedBody?: unknown;
  validatedQuery?: unknown;
  validatedParams?: unknown;
}

function hasParse<TInput, TOutput>(schema: unknown): schema is ParseSchema<TInput, TOutput> {
  return typeof schema === 'object' && schema !== null && 'parse' in schema && typeof schema.parse === 'function';
}

function hasValidate<TInput, TOutput>(schema: unknown): schema is ValidateSchema<TInput, TOutput> {
  return typeof schema === 'object' && schema !== null && 'validate' in schema && typeof schema.validate === 'function';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'Unknown validation error';
}

function setValidatedValue<K extends keyof ValidationCarrier>(
  req: Request,
  key: K,
  value: ValidationCarrier[K],
): void {
  (req as Request & ValidationCarrier)[key] = value;
}

function runValidation<TInput, TOutput>(schema: unknown, value: TInput): TOutput | undefined {
  if (hasParse<TInput, TOutput>(schema)) {
    return schema.parse(value);
  }
  if (hasValidate<TInput, TOutput>(schema)) {
    const result = schema.validate(value);
    if (result.error) {
      throw result.error;
    }
    return result.value;
  }
  return undefined;
}

/**
 * Creates a middleware that acts as the "Cognitive Firewall" enforcement point.
 * Intercepts requests to MAS Execution, validates schema, and sanitizes input.
 * Accepts IFirewallService via DI (resolved from container before route setup).
 */
export function createValidationMiddleware(firewallService: IFirewallService) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Inspect & Sanitize
      // This throws if schema is invalid or heuristics are violated
      const cleanData = firewallService.inspectRequest(req.body);

      // 2. Replace body with sanitized data
      req.body = cleanData;

      next();
    } catch (error: unknown) {
      // Log security event here provided context
      console.warn(`[Security] Blocked Request: ${getErrorMessage(error)}`);

      // Return standardized error (masking internal stack)
      res.status(400).json({
        error: 'Security Policy Violation',
        message: getErrorMessage(error) // In prod, might want to be vaguer
      });
    }
  };
}

// --- Legacy / Generic Validation Support ---

export interface ValidatedRequest<T = unknown> extends Request {
  body: T;
  validatedBody: T;
  validatedQuery?: RequestValue;
  validatedParams?: RequestValue;
}

export function validateBody<TBody>(schema: BodySchema<TBody>) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const val = runValidation<unknown, TBody>(schema, req.body);
      if (val !== undefined) {
        req.body = val;
        setValidatedValue(req, 'validatedBody', val);
      }
      next();
    } catch (error: unknown) {
       res.status(400).json({ 
         success: false,
         error: { 
           code: 'VALIDATION_ERROR', 
           details: getErrorMessage(error) 
         } 
       });
    }
  };
}

export function validateQuery<TQuery>(schema: QuerySchema<TQuery>) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const val = runValidation<Request['query'], TQuery>(schema, req.query);
      if (val !== undefined) {
        setValidatedValue(req, 'validatedQuery', val);
      }
      next();
    } catch (error: unknown) {
      res.status(400).json({ 
        success: false,
        error: { 
          code: 'VALIDATION_ERROR', 
          details: getErrorMessage(error) 
        } 
      });
    }
  };
}

export function validateParams<TParams>(schema: ParamsSchema<TParams>) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const val = runValidation<Request['params'], TParams>(schema, req.params);
      if (val !== undefined) {
        setValidatedValue(req, 'validatedParams', val);
      }
      next();
    } catch (error: unknown) {
      res.status(400).json({ 
        success: false,
        error: { 
          code: 'VALIDATION_ERROR', 
          details: getErrorMessage(error) 
        } 
      });
    }
  };
}

export function validateRequest<TBody, TQuery, TParams>(
  schemas: RequestValidationSchemas<TBody, TQuery, TParams>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        const val = runValidation<unknown, TBody>(schemas.body, req.body);
        if (val !== undefined) {
          req.body = val;
          setValidatedValue(req, 'validatedBody', val);
        }
      }
      if (schemas.query) {
        const val = runValidation<Request['query'], TQuery>(schemas.query, req.query);
        if (val !== undefined) {
          setValidatedValue(req, 'validatedQuery', val);
        }
      }
      if (schemas.params) {
        const val = runValidation<Request['params'], TParams>(schemas.params, req.params);
        if (val !== undefined) {
          setValidatedValue(req, 'validatedParams', val);
        }
      }
      next();
    } catch (error: unknown) {
      res.status(400).json({ 
        success: false,
        error: { 
          code: 'VALIDATION_ERROR', 
          details: getErrorMessage(error) 
        } 
      });
    }
  };
}
