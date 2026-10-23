/**
 * PostgresSpendStateStore — PostgreSQL-backed persistence for FinOps spend state.
 *
 * Implements ISpendStateStore using IDatabaseConnection (JSONB columns).
 * Used by DurableTokenomicsDecorator to survive service restarts.
 *
 * Table: finops.agent_spend_state (auto-created via ensureTable).
 *
 * @layer Infrastructure
 * @phase Horizon 2.2 — FinOps for AI Agents (Durability Extension)
 */

import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import type { ISpendStateStore } from './DurableTokenomicsDecorator';
import type {
  AgentSpendState,
  TokenomicsBudgetPolicy,
} from '../../domain/finops/ITokenomicsController';

// ── DB row shape ───────────────────────────────────────────────────

interface SpendStateRow {
  scope_id: string;
  state: AgentSpendState;
  policy: TokenomicsBudgetPolicy;
}

// ── Implementation ─────────────────────────────────────────────────

export class PostgresSpendStateStore implements ISpendStateStore {
  private tableEnsured = false;

  constructor(private readonly db: IDatabaseConnection) {}

  async save(scopeId: string, state: AgentSpendState, policy: TokenomicsBudgetPolicy): Promise<void> {
    await this.ensureTable();
    await this.db.query(
      `INSERT INTO finops.agent_spend_state (scope_id, state, policy, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (scope_id) DO UPDATE SET
         state = EXCLUDED.state,
         policy = EXCLUDED.policy,
         updated_at = now()`,
      [scopeId, JSON.stringify(state), JSON.stringify(policy)],
    );
  }

  async load(scopeId: string): Promise<{ state: AgentSpendState; policy: TokenomicsBudgetPolicy } | null> {
    await this.ensureTable();
    const result = await this.db.query<SpendStateRow>(
      'SELECT state, policy FROM finops.agent_spend_state WHERE scope_id = $1',
      [scopeId],
    );
    if (result.rows.length === 0) return null;
    return { state: result.rows[0].state, policy: result.rows[0].policy };
  }

  async remove(scopeId: string): Promise<void> {
    await this.ensureTable();
    await this.db.query(
      'DELETE FROM finops.agent_spend_state WHERE scope_id = $1',
      [scopeId],
    );
  }

  async listScopeIds(): Promise<string[]> {
    await this.ensureTable();
    const result = await this.db.query<{ scope_id: string }>(
      'SELECT scope_id FROM finops.agent_spend_state ORDER BY scope_id',
    );
    return result.rows.map((r) => r.scope_id);
  }

  // ── Schema bootstrap ──────────────────────────────────────────

  private async ensureTable(): Promise<void> {
    if (this.tableEnsured) return;

    await this.db.query('CREATE SCHEMA IF NOT EXISTS finops');
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS finops.agent_spend_state (
        scope_id   TEXT PRIMARY KEY,
        state      JSONB NOT NULL,
        policy     JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    this.tableEnsured = true;
  }
}
