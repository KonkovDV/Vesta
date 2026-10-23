/**
 * Presidio Content Scanner - Production PII detection via Microsoft Presidio.
 *
 * Layer: Infrastructure (integrates with external Presidio service)
 *
 * This implementation connects to Presidio Analyzer and Anonymizer APIs
 * to detect and optionally redact PII in memory content.
 *
 * @see https://microsoft.github.io/presidio/
 */

import type {
  IContentScanner,
  ContentScanInput,
  ContentScanResult,
  ContentSensitivity,
  DetectedEntity,
} from '../../domain/memory/governance/content-scanner';

import type { IHttpClient } from '../http/HttpClient';
import { logger } from '../logging/logger';
import {
  recordContentScanDuration,
  incrementContentScanBlocked,
  incrementContentScanEntities,
  incrementContentScanRedacted,
  recordContentScanError,
} from '../../monitoring/memory-content-scan-metrics';

const log = logger.child({ component: 'PresidioContentScanner' });

/**
 * Presidio Analyzer response entity.
 */
interface PresidioAnalyzerEntity {
  entity_type: string;
  start: number;
  end: number;
  score: number;
  recognition_metadata?: {
    recognizer_name?: string;
    recognizer_identifier?: string;
  };
}

/**
 * Presidio Anonymizer response.
 */
interface PresidioAnonymizerResponse {
  text: string;
  items: Array<{
    entity_type: string;
    start: number;
    end: number;
    operator: string;
    text: string;
  }>;
}

/**
 * Configuration for Presidio scanner.
 */
export interface PresidioConfig {
  /** URL of Presidio Analyzer service (e.g., http://presidio-analyzer:3000) */
  analyzerUrl: string;
  /** URL of Presidio Anonymizer service (e.g., http://presidio-anonymizer:3000) */
  anonymizerUrl: string;
  /** Minimum confidence score to consider an entity (0-1) */
  minConfidence?: number;
  /** Language hint for analyzer */
  language?: string;
  /** Timeout for API calls in ms */
  timeoutMs?: number;
  /** Entity types to detect (empty = all supported) */
  entities?: string[];
}

/**
 * Mapping from Presidio entity types to sensitivity levels.
 */
const ENTITY_SENSITIVITY_MAP: Record<string, ContentSensitivity> = {
  // PII - Personal Identifiable Information
  PERSON: 'pii',
  EMAIL_ADDRESS: 'pii',
  PHONE_NUMBER: 'pii',
  US_SSN: 'restricted',
  US_PASSPORT: 'restricted',
  US_DRIVER_LICENSE: 'restricted',
  CREDIT_CARD: 'restricted',
  IBAN_CODE: 'restricted',
  
  // Confidential
  IP_ADDRESS: 'confidential',
  LOCATION: 'confidential',
  DATE_TIME: 'internal',
  NRP: 'confidential', // National Registration Number
  
  // Medical
  MEDICAL_LICENSE: 'restricted',
  
  // Default for unknown types
  DEFAULT: 'pii',
};

/**
 * Presidio Content Scanner implementation.
 *
 * Calls Presidio Analyzer to detect entities, then optionally
 * calls Anonymizer to redact detected PII.
 */
export class PresidioContentScanner implements IContentScanner {
  private readonly analyzerUrl: string;
  private readonly anonymizerUrl: string;
  private readonly minConfidence: number;
  private readonly language: string;
  private readonly timeoutMs: number;
  private readonly entities: string[];

  constructor(
    private readonly httpClient: IHttpClient,
    config: PresidioConfig,
  ) {
    this.analyzerUrl = config.analyzerUrl.replace(/\/$/, '');
    this.anonymizerUrl = config.anonymizerUrl.replace(/\/$/, '');
    this.minConfidence = config.minConfidence ?? 0.5;
    this.language = config.language ?? 'en';
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.entities = config.entities ?? [];
  }

  async scan(input: ContentScanInput): Promise<ContentScanResult> {
    const start = Date.now();

    try {
      // 1. Call Presidio Analyzer
      const entities = await this.analyzeContent(input.content);
      
      // 2. Determine sensitivity level
      const sensitivity = this.determineSensitivity(entities);
      
      // 3. Check if content should be blocked
      const allowed = this.isAllowed(sensitivity, input.reject_above);
      
      // 4. Optionally redact content
      let redactedContent: string | undefined;
      if (input.redact && entities.length > 0) {
        redactedContent = await this.anonymizeContent(input.content, entities);
        incrementContentScanRedacted({ scanner: 'presidio' });
      }
      
      // 5. Map entities to our format
      const detectedEntities = this.mapEntities(entities);

      // Record metrics
      detectedEntities.forEach((entity) => {
        incrementContentScanEntities({
          entityType: entity.entity_type,
          scanner: 'presidio',
        });
      });

      if (!allowed) {
        incrementContentScanBlocked({
          sensitivity,
          reason: 'threshold_exceeded',
        });
      }

      recordContentScanDuration({
        scanner: 'presidio',
        sensitivity,
        allowed,
        durationSeconds: (Date.now() - start) / 1000,
      });

      log.info('Content scanned', {
        tenant_id: input.tenant_id,
        correlation_id: input.correlation_id,
        entity_count: entities.length,
        sensitivity,
        allowed,
        duration_ms: Date.now() - start,
      });

      return {
        allowed,
        sensitivity,
        detected_entities: detectedEntities,
        redacted_content: redactedContent,
        scan_duration_ms: Date.now() - start,
        scanner_version: 'presidio-v1.0.0',
      };
    } catch (error) {
      log.error('Content scan failed', {
        tenant_id: input.tenant_id,
        correlation_id: input.correlation_id,
        error: error instanceof Error ? error.message : String(error),
      });

      recordContentScanError({
        scanner: 'presidio',
        error,
      });

      // Fail-open: allow content but log the error
      return {
        allowed: true,
        sensitivity: 'public',
        detected_entities: [],
        scan_duration_ms: Date.now() - start,
        scanner_version: 'presidio-v1.0.0-error',
      };
    }
  }

  /**
   * Call Presidio Analyzer to detect entities.
   */
  private async analyzeContent(content: string): Promise<PresidioAnalyzerEntity[]> {
    const response = await this.httpClient.request({
      method: 'POST',
      url: `${this.analyzerUrl}/analyze`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: content,
        language: this.language,
        entities: this.entities.length > 0 ? this.entities : undefined,
        score_threshold: this.minConfidence,
      }),
      timeoutMs: this.timeoutMs,
    });

    if (response.statusCode !== 200) {
      throw new Error(`Presidio Analyzer returned ${response.statusCode}`);
    }

    const body = typeof response.body === 'string' 
      ? JSON.parse(response.body) 
      : response.body;
    
    return Array.isArray(body) ? body : [];
  }

  /**
   * Call Presidio Anonymizer to redact entities.
   */
  private async anonymizeContent(
    content: string,
    entities: PresidioAnalyzerEntity[],
  ): Promise<string> {
    const anonymizers = entities.reduce((acc, entity) => {
      if (!acc[entity.entity_type]) {
        acc[entity.entity_type] = {
          type: 'replace',
          new_value: `[${entity.entity_type}]`,
        };
      }
      return acc;
    }, {} as Record<string, { type: string; new_value: string }>);

    const response = await this.httpClient.request({
      method: 'POST',
      url: `${this.anonymizerUrl}/anonymize`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: content,
        analyzer_results: entities.map(e => ({
          entity_type: e.entity_type,
          start: e.start,
          end: e.end,
          score: e.score,
        })),
        anonymizers,
      }),
      timeoutMs: this.timeoutMs,
    });

    if (response.statusCode !== 200) {
      throw new Error(`Presidio Anonymizer returned ${response.statusCode}`);
    }

    const body: PresidioAnonymizerResponse = typeof response.body === 'string'
      ? JSON.parse(response.body)
      : response.body;
    
    return body.text;
  }

  /**
   * Determine overall sensitivity from detected entities.
   */
  private determineSensitivity(entities: PresidioAnalyzerEntity[]): ContentSensitivity {
    if (entities.length === 0) {
      return 'public';
    }

    const sensitivityOrder: ContentSensitivity[] = [
      'public',
      'internal',
      'confidential',
      'pii',
      'restricted',
    ];

    let maxLevel: ContentSensitivity = 'public';
    
    for (const entity of entities) {
      const level = ENTITY_SENSITIVITY_MAP[entity.entity_type] 
        ?? ENTITY_SENSITIVITY_MAP['DEFAULT'];
      
      if (sensitivityOrder.indexOf(level) > sensitivityOrder.indexOf(maxLevel)) {
        maxLevel = level;
      }
    }

    return maxLevel;
  }

  /**
   * Check if content is allowed based on sensitivity threshold.
   */
  private isAllowed(
    sensitivity: ContentSensitivity,
    rejectAbove?: ContentSensitivity,
  ): boolean {
    if (!rejectAbove) {
      return true; // No threshold = always allow
    }

    const sensitivityOrder: ContentSensitivity[] = [
      'public',
      'internal',
      'confidential',
      'pii',
      'restricted',
    ];

    return sensitivityOrder.indexOf(sensitivity) < sensitivityOrder.indexOf(rejectAbove);
  }

  /**
   * Map Presidio entities to our DetectedEntity format.
   */
  private mapEntities(entities: PresidioAnalyzerEntity[]): DetectedEntity[] {
    return entities.map(e => ({
      entity_type: e.entity_type.toLowerCase(),
      start: e.start,
      end: e.end,
      confidence: e.score,
      redaction: `[${e.entity_type}]`,
    }));
  }
}
