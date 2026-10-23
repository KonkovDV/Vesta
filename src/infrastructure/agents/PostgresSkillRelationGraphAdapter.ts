/**
 * PostgreSQL Skill Relation Graph Adapter — production implementation of ISkillRelationGraph.
 *
 * Persistent graph store backed by PostgreSQL with recursive CTE-based traversal,
 * Prometheus metrics, and structured logging. Replaces the in-memory @sota-stub.
 *
 * Key design decisions (arXiv:2603.04448, SkillNet §3.5):
 * - Recursive CTEs for BFS path finding with cycle detection via `NOT target = ANY(path)`
 * - Multiplicative confidence decay across edges (§3.5 Skill Connection)
 * - Symmetric storage for similar_to (both directions inserted/deleted atomically)
 * - Auto-migration via `ensureSchema()` — idempotent CREATE TABLE IF NOT EXISTS
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-037 Skill Relation Graph (FITNESS-K: 79)
 * @academic SkillNet (arXiv:2603.04448, Liang et al., 2026) — Donor #28 EXTRACT-K
 * @enriched-by agency-agents 15-division taxonomy (Donor #30 ENRICH AA-E02)
 * @see src/domain/agents/ISkillRelationGraph.ts — domain port
 * @see src/infrastructure/agents/SkillRelationGraphAdapter.ts — in-memory fallback
 */

import type {
  IDatabaseConnection,
  QueryResult,
} from '../../domain/persistence/IDatabaseConnection';
import type {
  ISkillRelationGraph,
  SkillRelation,
  SkillRelationQuery,
  SkillGraphNode,
  SkillPathResult,
  SkillRelationType,
  SkillDivisionNode,
} from '../../domain/agents/ISkillRelationGraph';
import { logger } from '../logging/logger';
import { getOrCreateCounter, getOrCreateHistogram } from '../../monitoring';

// ── Metrics ────────────────────────────────────────────────────────

type SkillGraphOperation =
  | 'getRelations'
  | 'addRelation'
  | 'removeRelation'
  | 'findPath'
  | 'getCompositionChain'
  | 'getDependencies'
  | 'findSimilar'
  | 'getNode'
  | 'getDivisionTree'
  | 'getByDivision'
  | 'ensureSchema';

type SkillGraphOutcome = 'success' | 'error';

const skillGraphRequestsTotal = getOrCreateCounter(
  'skill_graph_requests_total',
  'Total PostgresSkillRelationGraphAdapter operations by type and outcome',
  ['operation', 'outcome'],
);

const skillGraphRequestDurationSeconds = getOrCreateHistogram(
  'skill_graph_request_duration_seconds',
  'Duration of PostgresSkillRelationGraphAdapter operations in seconds',
  ['operation', 'outcome'],
);

// ── SQL Row Types ──────────────────────────────────────────────────

interface RelationRow {
  source_skill: string;
  target_skill: string;
  relation_type: SkillRelationType;
  confidence: number;
  inference: string | null;
  evidence: string | null;
}

interface PathRow {
  target_skill: string;
  confidence: number;
  relation_type: SkillRelationType;
  depth: number;
  path: string[];
}

interface TaxonomyRow {
  taxonomy_path: string[];
}

// ── Adapter ────────────────────────────────────────────────────────

export class PostgresSkillRelationGraphAdapter implements ISkillRelationGraph {
  private readonly log = logger.child({ component: 'PostgresSkillRelationGraph' });
  private schemaEnsured = false;

  constructor(private readonly db: IDatabaseConnection) {}

  // ── Schema Migration ──────────────────────────────────────────────

  /**
   * Idempotent schema creation. Called lazily on first operation.
   */
  async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;

    const started = process.hrtime.bigint();

    try {
      await this.db.execute(`
        CREATE TABLE IF NOT EXISTS skill_relations (
          id SERIAL PRIMARY KEY,
          source_skill TEXT NOT NULL,
          target_skill TEXT NOT NULL,
          relation_type TEXT NOT NULL
            CHECK (relation_type IN ('similar_to', 'compose_with', 'belong_to', 'depend_on')),
          confidence NUMERIC(3,2) NOT NULL
            CHECK (confidence >= 0 AND confidence <= 1),
          inference TEXT
            CHECK (inference IS NULL OR inference IN ('embedding', 'llm', 'manual')),
          evidence TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (source_skill, target_skill, relation_type)
        )
      `);

      await this.db.execute(`
        CREATE TABLE IF NOT EXISTS skill_taxonomy (
          skill_id VARCHAR(255) PRIMARY KEY,
          taxonomy_path TEXT[] NOT NULL
        )
      `);

      await this.db.execute(`
        CREATE TABLE IF NOT EXISTS skill_divisions (
          division_id VARCHAR(255) PRIMARY KEY,
          label VARCHAR(255) NOT NULL,
          parent_division_id VARCHAR(255),
          child_division_ids TEXT[] NOT NULL DEFAULT '{}'
        )
      `);

      await this.db.execute(`
        CREATE TABLE IF NOT EXISTS skill_division_members (
          skill_id VARCHAR(255) NOT NULL,
          division_id VARCHAR(255) NOT NULL REFERENCES skill_divisions(division_id),
          PRIMARY KEY (skill_id, division_id)
        )
      `);

      // Indexes for common query patterns
      await this.db.execute(`
        CREATE INDEX IF NOT EXISTS idx_skill_relations_source
          ON skill_relations (source_skill, relation_type)
      `);
      await this.db.execute(`
        CREATE INDEX IF NOT EXISTS idx_skill_relations_target
          ON skill_relations (target_skill, relation_type)
      `);
      await this.db.execute(`
        CREATE INDEX IF NOT EXISTS idx_skill_relations_confidence
          ON skill_relations (confidence)
      `);

      this.schemaEnsured = true;
      this.observe('ensureSchema', 'success', started);
      this.log.info('Skill relation graph schema ensured');
    } catch (error) {
      this.observe('ensureSchema', 'error', started);
      this.log.error('Failed to ensure skill relation graph schema', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ── ISkillRelationGraph Implementation ────────────────────────────

  async getRelations(query: SkillRelationQuery): Promise<readonly SkillRelation[]> {
    await this.ensureSchema();
    const started = process.hrtime.bigint();

    try {
      const minConfidence = query.minConfidence ?? 0.5;
      const params: unknown[] = [query.skillId, minConfidence];

      let typeFilter = '';
      if (query.relationTypes && query.relationTypes.length > 0) {
        params.push(query.relationTypes);
        typeFilter = `AND relation_type = ANY($3::text[])`;
      }

      const sql = `
        SELECT source_skill, target_skill, relation_type, confidence, inference, evidence
        FROM skill_relations
        WHERE source_skill = $1 AND confidence >= $2 ${typeFilter}
        ORDER BY confidence DESC
      `;

      const result: QueryResult<RelationRow> = await this.db.query<RelationRow>(sql, params);
      const relations = result.rows.map((row) => this.toSkillRelation(row));

      this.observe('getRelations', 'success', started);
      return relations;
    } catch (error) {
      this.observe('getRelations', 'error', started);
      this.log.warn('getRelations failed', {
        skillId: query.skillId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async addRelation(relation: SkillRelation): Promise<boolean> {
    await this.ensureSchema();
    const started = process.hrtime.bigint();

    try {
      const insertSql = `INSERT INTO skill_relations (source_skill, target_skill, relation_type, confidence, inference, evidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_skill, target_skill, relation_type) DO NOTHING`;
      const params = [
        relation.sourceSkillId,
        relation.targetSkillId,
        relation.relationType,
        relation.confidence,
        relation.metadata?.inferenceMethod ?? null,
        relation.metadata?.evidence ?? null,
      ];
      const reverseParams = [
        relation.targetSkillId,
        relation.sourceSkillId,
        relation.relationType,
        relation.confidence,
        relation.metadata?.inferenceMethod ?? null,
        relation.metadata?.evidence ?? null,
      ];

      // Wrap in transaction for symmetric similar_to consistency
      const inserted = await this.db.transaction(async () => {
        const result = await this.db.execute(insertSql, params);

        if (relation.relationType === 'similar_to') {
          await this.db.execute(insertSql, reverseParams);
        }

        return result;
      });

      this.observe('addRelation', 'success', started);
      return inserted > 0;
    } catch (error) {
      this.observe('addRelation', 'error', started);
      this.log.warn('addRelation failed', {
        source: relation.sourceSkillId,
        target: relation.targetSkillId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async removeRelation(
    sourceSkillId: string,
    targetSkillId: string,
    relationType: SkillRelationType,
  ): Promise<boolean> {
    await this.ensureSchema();
    const started = process.hrtime.bigint();

    try {
      const deleteSql = `DELETE FROM skill_relations
         WHERE source_skill = $1 AND target_skill = $2 AND relation_type = $3`;

      // Wrap in transaction for symmetric similar_to consistency
      const deleted = await this.db.transaction(async () => {
        const result = await this.db.execute(deleteSql, [
          sourceSkillId, targetSkillId, relationType,
        ]);

        if (relationType === 'similar_to') {
          await this.db.execute(deleteSql, [
            targetSkillId, sourceSkillId, relationType,
          ]);
        }

        return result;
      });

      this.observe('removeRelation', 'success', started);
      return deleted > 0;
    } catch (error) {
      this.observe('removeRelation', 'error', started);
      this.log.warn('removeRelation failed', {
        source: sourceSkillId,
        target: targetSkillId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async findPath(
    fromSkillId: string,
    toSkillId: string,
    maxDepth = 5,
  ): Promise<SkillPathResult | null> {
    await this.ensureSchema();
    const started = process.hrtime.bigint();

    try {
      // Recursive CTE with BFS, multiplicative confidence, cycle detection
      const sql = `
        WITH RECURSIVE graph AS (
          SELECT
            target_skill,
            confidence,
            relation_type,
            1 AS depth,
            ARRAY[source_skill, target_skill] AS path
          FROM skill_relations
          WHERE source_skill = $1 AND confidence >= 0.01
          UNION ALL
          SELECT
            sr.target_skill,
            (g.confidence * sr.confidence)::NUMERIC(10,6),
            sr.relation_type,
            g.depth + 1,
            g.path || sr.target_skill
          FROM graph g
          JOIN skill_relations sr ON sr.source_skill = g.target_skill
          WHERE g.depth < $3
            AND NOT sr.target_skill = ANY(g.path)
            AND sr.confidence >= 0.01
        )
        SELECT target_skill, confidence, relation_type, depth, path
        FROM graph
        WHERE target_skill = $2
        ORDER BY confidence DESC
        LIMIT 1
      `;

      const result: QueryResult<PathRow> = await this.db.query<PathRow>(
        sql,
        [fromSkillId, toSkillId, maxDepth],
      );

      if (result.rows.length === 0) {
        this.observe('findPath', 'success', started);
        return null;
      }

      const row = result.rows[0];

      // Reconstruct relation types for each edge in the path
      const relationTypes = await this.getRelationTypesForPath(row.path);

      this.observe('findPath', 'success', started);
      return {
        from: fromSkillId,
        to: toSkillId,
        path: row.path,
        totalConfidence: Number(row.confidence),
        relationTypes,
      };
    } catch (error) {
      this.observe('findPath', 'error', started);
      this.log.warn('findPath failed', {
        from: fromSkillId,
        to: toSkillId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getCompositionChain(skillId: string): Promise<readonly string[]> {
    await this.ensureSchema();
    const started = process.hrtime.bigint();

    try {
      const sql = `
        WITH RECURSIVE chain AS (
          SELECT
            target_skill,
            1 AS depth,
            ARRAY[$1::text, target_skill] AS path
          FROM skill_relations
          WHERE source_skill = $1 AND relation_type = 'compose_with'
          UNION ALL
          SELECT
            sr.target_skill,
            c.depth + 1,
            c.path || sr.target_skill
          FROM chain c
          JOIN skill_relations sr
            ON sr.source_skill = c.target_skill
            AND sr.relation_type = 'compose_with'
          WHERE c.depth < 20
            AND NOT sr.target_skill = ANY(c.path)
        )
        SELECT path
        FROM chain
        ORDER BY depth DESC
        LIMIT 1
      `;

      const result = await this.db.query<{ path: string[] }>(sql, [skillId]);

      if (result.rows.length === 0) {
        this.observe('getCompositionChain', 'success', started);
        return [skillId];
      }

      this.observe('getCompositionChain', 'success', started);
      return result.rows[0].path;
    } catch (error) {
      this.observe('getCompositionChain', 'error', started);
      this.log.warn('getCompositionChain failed', {
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getDependencies(
    skillId: string,
    maxDepth = 3,
  ): Promise<readonly SkillRelation[]> {
    await this.ensureSchema();
    const started = process.hrtime.bigint();

    try {
      const sql = `
        WITH RECURSIVE deps AS (
          SELECT source_skill, target_skill, confidence, inference, evidence, 1 AS depth,
                 ARRAY[source_skill, target_skill] AS path
          FROM skill_relations
          WHERE source_skill = $1 AND relation_type = 'depend_on'
          UNION ALL
          SELECT sr.source_skill, sr.target_skill, sr.confidence, sr.inference, sr.evidence,
                 d.depth + 1,
                 d.path || sr.target_skill
          FROM deps d
          JOIN skill_relations sr
            ON sr.source_skill = d.target_skill
            AND sr.relation_type = 'depend_on'
          WHERE d.depth < $2
            AND NOT sr.target_skill = ANY(d.path)
        )
        SELECT source_skill, target_skill, 'depend_on'::text AS relation_type,
               confidence, inference, evidence
        FROM deps
      `;

      const result: QueryResult<RelationRow> = await this.db.query<RelationRow>(
        sql,
        [skillId, maxDepth],
      );

      const relations = result.rows.map((row) => this.toSkillRelation(row));
      this.observe('getDependencies', 'success', started);
      return relations;
    } catch (error) {
      this.observe('getDependencies', 'error', started);
      this.log.warn('getDependencies failed', {
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async findSimilar(
    skillId: string,
    minConfidence = 0.5,
  ): Promise<readonly SkillRelation[]> {
    await this.ensureSchema();
    const started = process.hrtime.bigint();

    try {
      const sql = `
        SELECT source_skill, target_skill, relation_type, confidence, inference, evidence
        FROM skill_relations
        WHERE source_skill = $1 AND relation_type = 'similar_to' AND confidence >= $2
        ORDER BY confidence DESC
      `;

      const result: QueryResult<RelationRow> = await this.db.query<RelationRow>(
        sql,
        [skillId, minConfidence],
      );

      const relations = result.rows.map((row) => this.toSkillRelation(row));
      this.observe('findSimilar', 'success', started);
      return relations;
    } catch (error) {
      this.observe('findSimilar', 'error', started);
      this.log.warn('findSimilar failed', {
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getNode(skillId: string): Promise<SkillGraphNode | null> {
    await this.ensureSchema();
    const started = process.hrtime.bigint();

    try {
      const relSql = `
        SELECT source_skill, target_skill, relation_type, confidence, inference, evidence
        FROM skill_relations
        WHERE source_skill = $1
        ORDER BY confidence DESC
      `;

      const relResult: QueryResult<RelationRow> = await this.db.query<RelationRow>(
        relSql,
        [skillId],
      );

      if (relResult.rows.length === 0) {
        this.observe('getNode', 'success', started);
        return null;
      }

      // Fetch taxonomy path if available
      const taxResult = await this.db.queryOne<TaxonomyRow>(
        `SELECT taxonomy_path FROM skill_taxonomy WHERE skill_id = $1`,
        [skillId],
      );

      const relations = relResult.rows.map((row) => this.toSkillRelation(row));

      this.observe('getNode', 'success', started);
      return {
        skillId,
        relations,
        taxonomyPath: taxResult?.taxonomy_path,
      };
    } catch (error) {
      this.observe('getNode', 'error', started);
      this.log.warn('getNode failed', {
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ── Setup Helper (not part of domain port) ────────────────────────

  async getDivisionTree(): Promise<readonly SkillDivisionNode[]> {
    await this.ensureSchema();
    const started = process.hrtime.bigint();

    try {
      const sql = `
        WITH RECURSIVE descendants AS (
          SELECT division_id AS root_division_id, division_id AS descendant_division_id
          FROM skill_divisions
          UNION
          SELECT d.root_division_id, child.division_id
          FROM descendants d
          JOIN skill_divisions child
            ON child.parent_division_id = d.descendant_division_id
        ), member_counts AS (
          SELECT
            d.root_division_id AS division_id,
            COUNT(DISTINCT m.skill_id)::int AS skill_count
          FROM descendants d
          LEFT JOIN skill_division_members m
            ON m.division_id = d.descendant_division_id
          GROUP BY d.root_division_id
        )
        SELECT d.division_id, d.label, d.parent_division_id, d.child_division_ids,
               COALESCE(mc.cnt, 0) AS skill_count
        FROM skill_divisions d
        LEFT JOIN member_counts mc ON mc.division_id = d.division_id
        ORDER BY d.label
      `;

      const result = await this.db.query<{
        division_id: string;
        label: string;
        parent_division_id: string | null;
        child_division_ids: string[];
        skill_count: number;
      }>(sql, []);

      const nodes: SkillDivisionNode[] = result.rows.map((row) => ({
        divisionId: row.division_id,
        label: row.label,
        parentDivisionId: row.parent_division_id ?? undefined,
        childDivisionIds: row.child_division_ids,
        skillCount: row.skill_count,
      }));

      this.observe('getDivisionTree', 'success', started);
      return nodes;
    } catch (error) {
      this.observe('getDivisionTree', 'error', started);
      this.log.warn('getDivisionTree failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getByDivision(
    divisionId: string,
    includeSubDivisions = true,
  ): Promise<readonly string[]> {
    await this.ensureSchema();
    const started = process.hrtime.bigint();

    try {
      let sql: string;
      let params: unknown[];

      if (includeSubDivisions) {
        sql = `
          WITH RECURSIVE subtree AS (
            SELECT division_id
            FROM skill_divisions
            WHERE division_id = $1
            UNION
            SELECT child.division_id
            FROM skill_divisions child
            JOIN subtree parent ON child.parent_division_id = parent.division_id
          )
          SELECT DISTINCT m.skill_id
          FROM skill_division_members m
          JOIN subtree s ON s.division_id = m.division_id
        `;
        params = [divisionId];
      } else {
        sql = `SELECT skill_id FROM skill_division_members WHERE division_id = $1`;
        params = [divisionId];
      }

      const result = await this.db.query<{ skill_id: string }>(sql, params);
      this.observe('getByDivision', 'success', started);
      return result.rows.map((r) => r.skill_id);
    } catch (error) {
      this.observe('getByDivision', 'error', started);
      this.log.warn('getByDivision failed', {
        divisionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Set taxonomy path for a skill (used during initialization). */
  async setTaxonomyPath(skillId: string, path: readonly string[]): Promise<void> {
    await this.ensureSchema();

    await this.db.execute(
      `INSERT INTO skill_taxonomy (skill_id, taxonomy_path)
       VALUES ($1, $2::text[])
       ON CONFLICT (skill_id) DO UPDATE SET taxonomy_path = EXCLUDED.taxonomy_path`,
      [skillId, path],
    );
  }

  // ── Private Helpers ───────────────────────────────────────────────

  /**
   * Reconstruct relation types for each edge in a path via a single query.
   * Given path [A, B, C], fetches relation types for A→B and B→C in one round-trip.
   */
  private async getRelationTypesForPath(path: string[]): Promise<SkillRelationType[]> {
    if (path.length < 2) return [];

    // Build pairs and parameter arrays for a single WHERE (source, target) IN (...) query
    const pairs: Array<[string, string]> = [];
    const params: string[] = [];
    const conditions: string[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      pairs.push([path[i], path[i + 1]]);
      const baseIdx = i * 2;
      conditions.push(`(source_skill = $${baseIdx + 1} AND target_skill = $${baseIdx + 2})`);
      params.push(path[i], path[i + 1]);
    }

    const rows = await this.db.query<{
      source_skill: string;
      target_skill: string;
      relation_type: SkillRelationType;
    }>(
      `SELECT DISTINCT ON (source_skill, target_skill)
              source_skill, target_skill, relation_type
       FROM skill_relations
       WHERE ${conditions.join(' OR ')}
       ORDER BY source_skill, target_skill, confidence DESC`,
      params,
    );

    // Build lookup map and reconstruct ordered result
    const lookup = new Map<string, SkillRelationType>();
    for (const row of rows.rows) {
      lookup.set(`${row.source_skill}→${row.target_skill}`, row.relation_type);
    }

    return pairs.map(
      ([src, tgt]) => lookup.get(`${src}→${tgt}`) ?? 'compose_with',
    );
  }

  private toSkillRelation(row: RelationRow): SkillRelation {
    return {
      sourceSkillId: row.source_skill,
      targetSkillId: row.target_skill,
      relationType: row.relation_type,
      confidence: Number(row.confidence),
      ...(row.inference
        ? {
            metadata: {
              inferenceMethod: row.inference as 'embedding' | 'llm' | 'manual',
              ...(row.evidence ? { evidence: row.evidence } : {}),
            },
          }
        : {}),
    };
  }

  private observe(
    operation: SkillGraphOperation,
    outcome: SkillGraphOutcome,
    startedAt: bigint,
  ): void {
    try {
      const elapsedNs = process.hrtime.bigint() - startedAt;
      const durationSeconds = Number(elapsedNs) / 1e9;

      skillGraphRequestsTotal.labels({ operation, outcome }).inc();
      skillGraphRequestDurationSeconds
        .labels({ operation, outcome })
        .observe(durationSeconds);
    } catch {
      // metrics must never break business logic
    }
  }
}
