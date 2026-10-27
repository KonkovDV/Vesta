-- Tables that used to be created on first use.
-- 001_consolidated.sql is unchanged: a database that already stored its checksum accepts this file.
-- Indexes are ordinary CREATE INDEX so the runner can apply this file in one transaction.

CREATE TABLE IF NOT EXISTS learning_structured_tips (
  tip_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  task_domain TEXT NULL,
  priority DOUBLE PRECISION NOT NULL,
  generated_at TIMESTAMPTZ NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_tip_feedback (
  tip_id TEXT PRIMARY KEY,
  used BOOLEAN NOT NULL,
  helpful BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_extracted_lessons (
  lesson_id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  root_cause_category TEXT NOT NULL,
  extracted_at TIMESTAMPTZ NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_consolidated_principles (
  principle_id TEXT PRIMARY KEY,
  root_cause_category TEXT NOT NULL,
  consolidated_at TIMESTAMPTZ NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_success_ledger_entries (
  entry_id TEXT PRIMARY KEY,
  root_cause_category TEXT NOT NULL,
  session_id TEXT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learning_success_ledger_entries_root_cause_category
  ON learning_success_ledger_entries (root_cause_category);

CREATE INDEX IF NOT EXISTS idx_learning_success_ledger_entries_session_id
  ON learning_success_ledger_entries (session_id);

CREATE INDEX IF NOT EXISTS idx_learning_success_ledger_entries_timestamp
  ON learning_success_ledger_entries (timestamp DESC);

CREATE TABLE IF NOT EXISTS learning_trajectory_intelligence (
  trajectory_id TEXT PRIMARY KEY,
  outcome_classification TEXT NOT NULL,
  analyzed_at TIMESTAMPTZ NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_contrastive_trajectories (
  trajectory_id TEXT PRIMARY KEY,
  root_cause_category TEXT NOT NULL,
  outcome TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS error_graph_errors (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  affected_files TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  root_cause TEXT NOT NULL,
  rule TEXT NOT NULL,
  test_trap TEXT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL,
  fixed_at TIMESTAMPTZ NULL,
  verification TEXT NULL,
  embedding vector(1536) NULL,
  ast_embedding vector(1536) NULL,
  temporal_embedding vector(1536) NULL,
  recurrence_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS error_graph_patterns (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  description TEXT NOT NULL,
  error_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
);

CREATE TABLE IF NOT EXISTS error_graph_fixes (
  id TEXT PRIMARY KEY,
  error_id TEXT NOT NULL,
  description TEXT NOT NULL,
  ast_patch TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_graph_embedding_hnsw
  ON error_graph_errors
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_error_graph_ast_embedding_hnsw
  ON error_graph_errors
  USING hnsw (ast_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_error_graph_temporal_embedding_hnsw
  ON error_graph_errors
  USING hnsw (temporal_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
