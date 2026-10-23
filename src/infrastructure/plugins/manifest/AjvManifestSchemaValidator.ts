import fs from 'fs';
import path from 'path';
import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Schema } from 'ajv/dist/2020';
import { tryJsonParse } from '../../../core/utils/json';

import type {
  IManifestSchemaValidator,
  ManifestValidationIssue,
  ManifestValidationResult,
} from '../../../domain/plugins/manifest/manifest-schema-validator.interface';
import { ConfigurationError } from '../../../domain/errors/DomainError';

/**
 * Ajv-based implementation of IManifestSchemaValidator for manifest v2.
 *
 * - Loads JSON Schema once at construction time and compiles it.
 * - Uses JSON Schema 2020-12 dialect via Ajv 2020.
 * - Produces ManifestValidationResult instead of throwing on validation errors.
 *
 * Fatal technical errors (schema not readable/parsable, compilation failures)
 * are thrown from the constructor so that DI/bootstrap fails fast.
 */
export class AjvManifestSchemaValidator implements IManifestSchemaValidator {
  private readonly validateFn: ValidateFunction;

  constructor(schemaPath: string) {
    const resolvedPath = path.resolve(schemaPath);

    let schemaText: string;
    try {
      schemaText = fs.readFileSync(resolvedPath, 'utf-8');
    } catch (error) {
      throw new ConfigurationError(
        `Failed to read manifest schema from "${resolvedPath}": ${(error as Error).message}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    let schema: Schema;
    try {
      const parsed = tryJsonParse<Schema>(schemaText);
      if (!parsed.ok) {
        throw parsed.error;
      }
      schema = parsed.value;
    } catch (error) {
      throw new ConfigurationError(
        `Failed to parse manifest schema JSON from "${resolvedPath}": ${(error as Error).message}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    try {
      const ajv = new Ajv2020({
        allErrors: true,
        strict: false,
        allowUnionTypes: true,
      });

      // Reuse the same formats configuration as CLI and other tools.
      addFormats(ajv);

      this.validateFn = ajv.compile(schema);
    } catch (error) {
      throw new ConfigurationError(
        `Failed to compile manifest schema from "${resolvedPath}": ${(error as Error).message}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  validateManifest(rawManifest: unknown): ManifestValidationResult {
    const ok = this.validateFn(rawManifest);

    if (ok) {
      return { valid: true, issues: [] };
    }

    const issues: ManifestValidationIssue[] = (this.validateFn.errors ?? []).map(
      (error: ErrorObject): ManifestValidationIssue => ({
        path: error.instancePath && error.instancePath.length > 0 ? error.instancePath : '(root)',
        message: error.message ?? 'validation error',
        keyword: error.keyword,
      }),
    );

    return {
      valid: false,
      issues,
    };
  }
}