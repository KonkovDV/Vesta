-- Tables that the skill relation graph and the finops spend store used to create on first use.
-- 001 and 002 are unchanged: a database that already stored their checksums accepts this file.
-- The statements match the ones those stores still send when DB_RUNTIME_DDL=true.
-- Indexes are ordinary CREATE INDEX so the runner can apply this file in one transaction.

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
);

CREATE TABLE IF NOT EXISTS skill_taxonomy (
  skill_id VARCHAR(255) PRIMARY KEY,
  taxonomy_path TEXT[] NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_divisions (
  division_id VARCHAR(255) PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  parent_division_id VARCHAR(255),
  child_division_ids TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS skill_division_members (
  skill_id VARCHAR(255) NOT NULL,
  division_id VARCHAR(255) NOT NULL REFERENCES skill_divisions(division_id),
  PRIMARY KEY (skill_id, division_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_relations_source
  ON skill_relations (source_skill, relation_type);

CREATE INDEX IF NOT EXISTS idx_skill_relations_target
  ON skill_relations (target_skill, relation_type);

CREATE INDEX IF NOT EXISTS idx_skill_relations_confidence
  ON skill_relations (confidence);

CREATE SCHEMA IF NOT EXISTS finops;

CREATE TABLE IF NOT EXISTS finops.agent_spend_state (
  scope_id   TEXT PRIMARY KEY,
  state      JSONB NOT NULL,
  policy     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
