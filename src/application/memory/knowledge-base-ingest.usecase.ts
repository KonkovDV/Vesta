/**
 * Knowledge Base ingest use case for OpenMemory HSG.
 *
 * Layer: Application
 *
 * Narrow scope: index KB documents into HSG semantic/reflective sectors
 * and create simple graph relationships "kb_document → related_documents".
 */

import type { TenantId, CorrelationId } from '../../domain/memory/session-types';
import type { HSGClient } from '../../domain/memory/session-memory-ports';
import { RequestContext } from '../context/request-context';
import { recordBackendError } from '../../memory/observability/memory-metrics';

export interface KnowledgeBaseDocumentInput {
  /**
   * Stable identifier of the KB document within tenant scope.
   */
  id: string;
  /**
   * Textual content of the document (already pre-processed/segmented upstream).
   */
  content: string;
  /**
   * Arbitrary metadata coming from upstream KB pipeline.
   *
   * Expected (but not required) keys for relations:
   * - related_ids: string[] — explicit related document identifiers;
   * - previous_version_id: string — id of previous document version;
   * - section_parent_id: string — id of parent section/manual.
   */
  metadata?: Record<string, unknown>;
}

export interface KnowledgeBaseIngestInput {
  tenantId: TenantId;
  document: KnowledgeBaseDocumentInput;
  correlationId?: CorrelationId;
}

export interface KnowledgeBaseIngestResult {
  documentId: string;
  /**
   * HSG identifier returned by addToSector (when available).
   */
  hsgId?: string;
  /**
   * Number of successfully created HSG relationships for this document.
   */
  createdRelationships: number;
}

export interface KnowledgeBaseIngestDeps {
  hsgClient: HSGClient;
}

function resolveCorrelationId(explicit?: CorrelationId): CorrelationId {
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }

  try {
    const fromCtx = RequestContext.getCorrelationId();
    if (fromCtx) {
      return String(fromCtx);
    }
  } catch {
    // RequestContext may be unavailable (non-HTTP context) — fall back to synthetic id.
  }

  return `kb-ingest:${Date.now()}`;
}

function normalizeIdArray(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  return [];
}

function extractRelatedDocumentIds(metadata?: Record<string, unknown>): string[] {
  if (!metadata) {
    return [];
  }

  const meta = metadata as Record<string, unknown> & {
    related_ids?: unknown;
    relatedIds?: unknown;
    previous_version_id?: unknown;
    previousVersionId?: unknown;
    section_parent_id?: unknown;
    sectionParentId?: unknown;
  };

  const explicitRelated =
    meta.related_ids !== undefined ? meta.related_ids : meta.relatedIds;

  const previousVersion =
    meta.previous_version_id !== undefined
      ? meta.previous_version_id
      : meta.previousVersionId;

  const sectionParent =
    meta.section_parent_id !== undefined
      ? meta.section_parent_id
      : meta.sectionParentId;

  const result = new Set<string>();

  for (const id of normalizeIdArray(explicitRelated)) {
    result.add(id);
  }

  for (const id of normalizeIdArray(previousVersion)) {
    result.add(id);
  }

  for (const id of normalizeIdArray(sectionParent)) {
    result.add(id);
  }

  return Array.from(result);
}

export class KnowledgeBaseIngestUseCase {
  constructor(private readonly deps: KnowledgeBaseIngestDeps) {}

  async execute(input: KnowledgeBaseIngestInput): Promise<KnowledgeBaseIngestResult> {
    const correlationId = resolveCorrelationId(input.correlationId);
    const { tenantId, document } = input;

    const pointer = await this.deps.hsgClient.addToSector({
      tenant_id: tenantId,
      primary_sector: 'semantic',
      sectors: ['semantic', 'reflective'],
      content: document.content,
      metadata: {
        kind: 'kb_document',
        kb_document_id: document.id,
        ...(document.metadata ?? {}),
      },
      correlation_id: correlationId,
    });

    const relatedIds = extractRelatedDocumentIds(document.metadata);
    let createdRelationships = 0;

    for (const targetId of relatedIds) {
      try {
        await this.deps.hsgClient.createRelationship({
          tenant_id: tenantId,
          source_id: document.id,
          target_id: targetId,
          relationship: 'related',
          metadata: {
            source: 'kb_ingest',
            kb_document_id: document.id,
          },
          correlation_id: correlationId,
        });
        createdRelationships += 1;
      } catch (error) {
        // Relationship creation is best-effort and must not break ingest.
        recordBackendError({
          backend: 'hsg',
          operation: 'kb_relationship_ingest',
          error,
        });
      }
    }

    return {
      documentId: document.id,
      hsgId: pointer?.hsg_id,
      createdRelationships,
    };
  }
}