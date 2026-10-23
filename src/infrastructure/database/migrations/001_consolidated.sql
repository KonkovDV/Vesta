-- ============================================================================
-- MicroPhoenix — Consolidated Database Migration
-- ============================================================================
-- Version : 1.1.0
-- Date    : 2026-10-23
-- Purpose : The one baseline for a new database.
--           Idempotent (IF NOT EXISTS / IF EXISTS). The runner applies it in
--           one transaction and skips it on the next run when the checksum matches.
--           Indexes are ordinary CREATE INDEX. A concurrent build is slower and
--           cannot run inside the baseline transaction; it belongs in a later
--           file only when a live table must stay writable.
--
-- Replaces:
--   001_genesis_architecture.sql
--   010_savepoint_support.sql
--   040_add_gin_indexes.sql
--   041_add_outbox_unique_constraint.sql
--   050_create_event_store_schema.sql
--   051_create_outbox_schema.sql
--   052_create_mas_schema.sql
--   053_create_mas_runtime_projections.sql
--   054_create_feature_flags.sql
--   055_drop_events_v2.sql
--   060_payload_uri_and_index_cleanup.sql
--
-- Ordering rationale:
--   §1  Extensions         — must come first (vector, uuid-ossp)
--   §2  Schemas             — CREATE SCHEMA before any tables
--   §3  Event Store         — foundation for CQRS/ES
--   §4  Outbox              — transactional outbox pattern
--   §5  MAS core            — multi-agent execution store
--   §6  MAS runtime         — read-model projections
--   §7  Singularity         — cognitive memory subsystem
--   §8  Identity            — tenants & users
--   §9  Memory governance   — quota overrides
--   §10 Public tables       — long_term_memories, memory_vectors,
--                             savepoint_support, feature flags
--   §11 Archive legacy      — rename obsolete tables
--   §12 Cleanup             — drop orphaned objects & redundant indexes
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- §1  Extensions
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ═══════════════════════════════════════════════════════════════════════════
-- §2  Schemas
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS event_store;
CREATE SCHEMA IF NOT EXISTS outbox;
CREATE SCHEMA IF NOT EXISTS mas;
CREATE SCHEMA IF NOT EXISTS mas_runtime;
CREATE SCHEMA IF NOT EXISTS singularity;
CREATE SCHEMA IF NOT EXISTS memory;
CREATE SCHEMA IF NOT EXISTS identity;


-- ═══════════════════════════════════════════════════════════════════════════
-- §3  Event Store
-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 050_create_event_store_schema.sql + runtime postgres-event-store.ts

-- Global Sequence Number sequence
CREATE SEQUENCE IF NOT EXISTS event_store_events_gsn_seq;

CREATE TABLE IF NOT EXISTS event_store.events (
  event_id          VARCHAR(255) PRIMARY KEY,
  event_type        VARCHAR(100) NOT NULL,
  aggregate_id      VARCHAR(255) NOT NULL,
  aggregate_version INTEGER      NOT NULL,
  correlation_id    VARCHAR(255) NOT NULL,
  causation_id      VARCHAR(255),
  timestamp         TIMESTAMP    NOT NULL,
  schema_version    INTEGER      NOT NULL DEFAULT 1,
  payload           JSONB        NOT NULL,
  metadata          JSONB,
  gsn               BIGINT       DEFAULT nextval('event_store_events_gsn_seq'),
  payload_uri       TEXT
);

-- Safety ALTERs for existing databases (no-op on fresh deploy)
ALTER TABLE event_store.events ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE event_store.events ADD COLUMN IF NOT EXISTS gsn BIGINT;
ALTER TABLE event_store.events ADD COLUMN IF NOT EXISTS payload_uri TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attrdef ad
    JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'event_store' AND c.relname = 'events' AND a.attname = 'gsn'
      AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%event_store_events_gsn_seq%'
  ) THEN
    ALTER TABLE event_store.events ALTER COLUMN gsn SET DEFAULT nextval('event_store_events_gsn_seq');
  END IF;
END $$;

-- Rows created before the sequence existed stay invisible to a GSN reader.
UPDATE event_store.events
   SET gsn = nextval('event_store_events_gsn_seq')
 WHERE gsn IS NULL;

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_gsn
  ON event_store.events(gsn);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_agg_id_version_unique
  ON event_store.events(aggregate_id, aggregate_version);

CREATE INDEX IF NOT EXISTS idx_events_correlation
  ON event_store.events(correlation_id);

-- GIN indexes for JSONB containment queries (from 040)
CREATE INDEX IF NOT EXISTS idx_events_payload_gin
  ON event_store.events USING GIN (payload);

CREATE INDEX IF NOT EXISTS idx_events_metadata_gin
  ON event_store.events USING GIN (metadata);

CREATE INDEX IF NOT EXISTS idx_events_timestamp
  ON event_store.events(timestamp);

CREATE INDEX IF NOT EXISTS idx_events_mas_trace_id
  ON event_store.events ((payload->>'mas_trace_id'))
  WHERE payload->>'mas_trace_id' IS NOT NULL;

ALTER TABLE event_store.events
  ADD COLUMN IF NOT EXISTS semantic_embedding vector(384);

CREATE INDEX IF NOT EXISTS idx_events_semantic_embedding
  ON event_store.events USING hnsw (semantic_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Comments
COMMENT ON COLUMN event_store.events.payload_uri IS
  'URI to externalized payload blob (S3/GCS/Azure Blob). When present, the JSONB payload column contains {"__externalized": true} stub and the real content lives at this URI.';

-- Snapshots
CREATE TABLE IF NOT EXISTS event_store.snapshots (
  aggregate_id VARCHAR(255) PRIMARY KEY,
  version      INTEGER      NOT NULL,
  timestamp    TIMESTAMP    NOT NULL,
  data         JSONB        NOT NULL,
  metadata     JSONB
);


-- ═══════════════════════════════════════════════════════════════════════════
-- §4  Outbox
-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 051_create_outbox_schema.sql + runtime postgres-outbox.ts

CREATE TABLE IF NOT EXISTS outbox.messages (
  message_id        VARCHAR(255) PRIMARY KEY,
  event_id          VARCHAR(255) NOT NULL,
  event_type        VARCHAR(100) NOT NULL,
  aggregate_id      VARCHAR(255) NOT NULL,
  aggregate_version INTEGER      NOT NULL,
  correlation_id    VARCHAR(255) NOT NULL,
  causation_id      VARCHAR(255),
  event_timestamp   TIMESTAMP    NOT NULL,
  event_payload     JSONB        NOT NULL,
  event_metadata    JSONB,
  event_gsn         BIGINT,
  idempotency_key   VARCHAR(255),
  status            VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  retry_count       INTEGER      NOT NULL DEFAULT 0,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_retry_at     TIMESTAMP,
  published_at      TIMESTAMP,
  last_error        TEXT,
  transaction_id    VARCHAR(255),
  metadata          JSONB,
  payload_uri       TEXT,

  CONSTRAINT positive_version    CHECK (aggregate_version > 0),
  CONSTRAINT valid_status        CHECK (status IN ('PENDING','PROCESSING','PUBLISHED','FAILED','DEAD_LETTER')),
  CONSTRAINT positive_retry_count CHECK (retry_count >= 0),
  CONSTRAINT unique_event_id     UNIQUE (event_id)
);

-- Safety ALTERs for existing databases
ALTER TABLE outbox.messages ADD COLUMN IF NOT EXISTS event_gsn BIGINT;
ALTER TABLE outbox.messages ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
ALTER TABLE outbox.messages ADD COLUMN IF NOT EXISTS payload_uri TEXT;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_outbox_status
  ON outbox.messages(status);

CREATE INDEX IF NOT EXISTS idx_outbox_retry_count
  ON outbox.messages(status, retry_count, created_at);

CREATE INDEX IF NOT EXISTS idx_outbox_created_at
  ON outbox.messages(created_at);

CREATE INDEX IF NOT EXISTS idx_outbox_claim
  ON outbox.messages (created_at)
  WHERE status IN ('PENDING', 'FAILED', 'PROCESSING');

CREATE INDEX IF NOT EXISTS idx_outbox_aggregate_id
  ON outbox.messages(aggregate_id);

CREATE INDEX IF NOT EXISTS idx_outbox_correlation_id
  ON outbox.messages(correlation_id);

CREATE INDEX IF NOT EXISTS idx_outbox_event_type
  ON outbox.messages(event_type);

CREATE INDEX IF NOT EXISTS idx_outbox_transaction
  ON outbox.messages(transaction_id);

CREATE INDEX IF NOT EXISTS idx_outbox_status_gsn
  ON outbox.messages(status, event_gsn);

CREATE INDEX IF NOT EXISTS idx_outbox_event_gsn
  ON outbox.messages(event_gsn);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_agg_id_version_unique
  ON outbox.messages(aggregate_id, aggregate_version);

-- GIN indexes for JSONB queries (from 040)
CREATE INDEX IF NOT EXISTS idx_outbox_event_payload_gin
  ON outbox.messages USING GIN (event_payload);

CREATE INDEX IF NOT EXISTS idx_outbox_event_metadata_gin
  ON outbox.messages USING GIN (event_metadata);

-- Comment
COMMENT ON COLUMN outbox.messages.payload_uri IS
  'URI to externalized event payload blob. Mirrors event_store.events.payload_uri for outbox replay.';

-- Dead Letter Queue
CREATE TABLE IF NOT EXISTS outbox.dead_letter_queue (
  dlq_message_id      VARCHAR(255) PRIMARY KEY,
  original_message_id  VARCHAR(255) NOT NULL,
  event_id             VARCHAR(255) NOT NULL,
  event_type           VARCHAR(100) NOT NULL,
  aggregate_id         VARCHAR(255) NOT NULL,
  aggregate_version    INTEGER      NOT NULL,
  correlation_id       VARCHAR(255) NOT NULL,
  causation_id         VARCHAR(255),
  event_timestamp      TIMESTAMP,
  event_payload        JSONB        NOT NULL,
  event_metadata       JSONB,
  idempotency_key      VARCHAR(255),
  failure_reason       TEXT         NOT NULL,
  original_retry_count INTEGER      NOT NULL,
  moved_to_dlq_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  replay_attempts      INTEGER      NOT NULL DEFAULT 0,
  last_replay_at       TIMESTAMP,
  metadata             JSONB,

  CONSTRAINT positive_original_retry_count CHECK (original_retry_count >= 0),
  CONSTRAINT positive_replay_attempts      CHECK (replay_attempts >= 0),
  CONSTRAINT dlq_positive_version          CHECK (aggregate_version > 0)
);

-- Safety ALTER for existing databases
ALTER TABLE outbox.dead_letter_queue ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- DLQ Indexes
CREATE INDEX IF NOT EXISTS idx_dlq_moved_at
  ON outbox.dead_letter_queue(moved_to_dlq_at);

CREATE INDEX IF NOT EXISTS idx_dlq_event_type
  ON outbox.dead_letter_queue(event_type);

CREATE INDEX IF NOT EXISTS idx_dlq_original_message
  ON outbox.dead_letter_queue(original_message_id);

-- DLQ GIN indexes (from 040)
CREATE INDEX IF NOT EXISTS idx_dlq_event_payload_gin
  ON outbox.dead_letter_queue USING GIN (event_payload);

CREATE INDEX IF NOT EXISTS idx_dlq_metadata_gin
  ON outbox.dead_letter_queue USING GIN (metadata);


-- ═══════════════════════════════════════════════════════════════════════════
-- §5  MAS — Multi-Agent System
-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 052_create_mas_schema.sql + 030_create_mas_teams_swarms (from 001)
--         + runtime PostgresMasExecutionStore.ts

-- 5.1 Task Executions
CREATE TABLE IF NOT EXISTS mas.task_executions (
  task_execution_id        VARCHAR(255) PRIMARY KEY,
  task_id                  VARCHAR(255) NOT NULL,
  session_id               VARCHAR(255) NOT NULL,
  status                   VARCHAR(32)  NOT NULL,
  current_step_id          VARCHAR(255),
  attempts                 INTEGER      NOT NULL DEFAULT 0,
  last_error               JSONB,
  request_context_snapshot JSONB        NOT NULL,
  timeouts                 JSONB        NOT NULL,
  meta                     JSONB        NOT NULL,
  created_at               TIMESTAMP    NOT NULL,
  updated_at               TIMESTAMP    NOT NULL,
  locked_by                VARCHAR(255),
  lock_expires_at          TIMESTAMP,
  version                  INTEGER      NOT NULL DEFAULT 1
);

-- Safety ALTER for existing databases without version column
ALTER TABLE mas.task_executions ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- 5.2 Execution Steps
CREATE TABLE IF NOT EXISTS mas.execution_steps (
  step_id             VARCHAR(255) PRIMARY KEY,
  task_execution_id   VARCHAR(255) NOT NULL
    REFERENCES mas.task_executions(task_execution_id) ON DELETE CASCADE,
  step_index          INTEGER      NOT NULL,
  kind                VARCHAR(32)  NOT NULL,
  status              VARCHAR(32)  NOT NULL,
  attempts            INTEGER      NOT NULL,
  max_attempts        INTEGER,
  idempotency_key     VARCHAR(255) NOT NULL,
  input_snapshot      JSONB        NOT NULL,
  result_ref          JSONB,
  error               JSONB,
  started_at          TIMESTAMP,
  completed_at        TIMESTAMP,
  last_heartbeat_at   TIMESTAMP,
  memory_policy       VARCHAR(32),
  policy_decision_ref VARCHAR(255)
);

-- Unique constraints (idempotent via DO $$ guard)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uk_mas_step_task_index'
  ) THEN
    ALTER TABLE mas.execution_steps
      ADD CONSTRAINT uk_mas_step_task_index UNIQUE (task_execution_id, step_index);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uk_mas_step_task_idempotency'
  ) THEN
    ALTER TABLE mas.execution_steps
      ADD CONSTRAINT uk_mas_step_task_idempotency UNIQUE (task_execution_id, idempotency_key);
  END IF;
END $$;

-- 5.3 MAS Event Outbox
CREATE TABLE IF NOT EXISTS mas.event_outbox (
  id                   SERIAL       PRIMARY KEY,
  event_id             VARCHAR(255) NOT NULL UNIQUE,
  event_type           VARCHAR(255) NOT NULL,
  aggregate_id         VARCHAR(255) NOT NULL,
  payload              JSONB        NOT NULL,
  occurred_at          TIMESTAMP    NOT NULL,
  correlation_id       VARCHAR(255),
  created_at           TIMESTAMP    NOT NULL DEFAULT NOW(),
  processed_at         TIMESTAMP,
  processing_attempts  INTEGER      NOT NULL DEFAULT 0
);

-- 5.4 Teams
CREATE TABLE IF NOT EXISTS mas.teams (
  id            VARCHAR(255) PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  leader_id     VARCHAR(255) NOT NULL,
  manifest_json JSONB        NOT NULL,
  status        VARCHAR(50)  NOT NULL,
  version       INTEGER      NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL,
  updated_at    TIMESTAMP    NOT NULL
);

CREATE TABLE IF NOT EXISTS mas.team_members (
  team_id  VARCHAR(255) NOT NULL REFERENCES mas.teams(id) ON DELETE CASCADE,
  agent_id VARCHAR(255) NOT NULL,
  role     VARCHAR(100) NOT NULL,
  PRIMARY KEY (team_id, agent_id)
);

-- 5.5 Swarms
CREATE TABLE IF NOT EXISTS mas.swarms (
  id          VARCHAR(255) PRIMARY KEY,
  topic       VARCHAR(255) NOT NULL,
  config_json JSONB        NOT NULL,
  status      VARCHAR(50)  NOT NULL,
  created_at  TIMESTAMP    NOT NULL
);

CREATE TABLE IF NOT EXISTS mas.swarm_participants (
  swarm_id  VARCHAR(255) NOT NULL REFERENCES mas.swarms(id) ON DELETE CASCADE,
  agent_id  VARCHAR(255) NOT NULL,
  joined_at TIMESTAMP    NOT NULL,
  PRIMARY KEY (swarm_id, agent_id)
);

-- MAS Indexes
CREATE INDEX IF NOT EXISTS idx_mas_event_outbox_unprocessed
  ON mas.event_outbox(processed_at, created_at) WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mas_event_outbox_aggregate
  ON mas.event_outbox(aggregate_id);

CREATE INDEX IF NOT EXISTS idx_mas_task_status
  ON mas.task_executions(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_mas_task_session
  ON mas.task_executions(session_id);

CREATE INDEX IF NOT EXISTS idx_mas_task_execution_version
  ON mas.task_executions(task_execution_id, version);

CREATE INDEX IF NOT EXISTS idx_mas_step_task
  ON mas.execution_steps(task_execution_id, step_index);

CREATE INDEX IF NOT EXISTS idx_mas_step_status
  ON mas.execution_steps(status, last_heartbeat_at);

CREATE INDEX IF NOT EXISTS idx_mas_teams_status
  ON mas.teams(status);

CREATE INDEX IF NOT EXISTS idx_mas_team_members_agent
  ON mas.team_members(agent_id);

CREATE INDEX IF NOT EXISTS idx_mas_swarms_status
  ON mas.swarms(status);

CREATE INDEX IF NOT EXISTS idx_mas_swarms_topic
  ON mas.swarms(topic);

CREATE INDEX IF NOT EXISTS idx_mas_swarm_participants_agent
  ON mas.swarm_participants(agent_id);

-- MAS Comments
COMMENT ON TABLE mas.teams IS
  'Persistent state of MAS Teams (hierarchical agent groups)';
COMMENT ON TABLE mas.swarms IS
  'Ephemeral state of MAS Swarms (ad-hoc agent groups)';
COMMENT ON COLUMN mas.task_executions.version IS
  'Optimistic locking version for concurrent access control. Incremented on each update.';


-- ═══════════════════════════════════════════════════════════════════════════
-- §6  MAS Runtime — Read Model Projections
-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 053_create_mas_runtime_projections.sql

CREATE TABLE IF NOT EXISTS mas_runtime.mas_session_read_model (
  mas_session_id     TEXT         PRIMARY KEY,
  tenant_id          TEXT         NOT NULL,
  scenario_id        TEXT,
  status             VARCHAR(32)  NOT NULL,
  started_at         TIMESTAMPTZ  NOT NULL,
  completed_at       TIMESTAMPTZ,
  failed_at          TIMESTAMPTZ,
  last_error_category TEXT,
  tasks_total        INT          DEFAULT 0,
  tasks_failed       INT          DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mas_session_read_model_tenant_status_started
  ON mas_runtime.mas_session_read_model (tenant_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS mas_runtime.mas_task_stats_read_model (
  tenant_id      TEXT        NOT NULL,
  scenario_id    TEXT        NOT NULL,
  window_start   TIMESTAMPTZ NOT NULL,
  window_end     TIMESTAMPTZ NOT NULL,
  tasks_started  INT         NOT NULL,
  tasks_completed INT        NOT NULL,
  tasks_failed   INT         NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS idx_mas_task_stats_read_model_window
  ON mas_runtime.mas_task_stats_read_model (tenant_id, scenario_id, window_start, window_end);

-- Events carry ids such as tenant-1 and sess-1. A previous baseline stored them as uuid.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mas_runtime' AND table_name = 'mas_session_read_model'
      AND column_name = 'tenant_id' AND udt_name = 'uuid'
  ) THEN
    ALTER TABLE mas_runtime.mas_session_read_model
      ALTER COLUMN mas_session_id TYPE text USING mas_session_id::text,
      ALTER COLUMN tenant_id TYPE text USING tenant_id::text;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mas_runtime' AND table_name = 'mas_task_stats_read_model'
      AND column_name = 'tenant_id' AND udt_name = 'uuid'
  ) THEN
    ALTER TABLE mas_runtime.mas_task_stats_read_model
      ALTER COLUMN tenant_id TYPE text USING tenant_id::text;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- §7  Singularity — Cognitive Memory
-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 002_create_singularity_memory.sql (from 001)

CREATE TABLE IF NOT EXISTS singularity.thought_transient (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         VARCHAR(255) NOT NULL,
  thought_type     VARCHAR(50)  NOT NULL DEFAULT 'observation',
  content          JSONB        NOT NULL,
  token_cost       INTEGER      NOT NULL DEFAULT 0,
  importance_score REAL         NOT NULL DEFAULT 0.5,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  metadata         JSONB        DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_thought_transient_expires
  ON singularity.thought_transient(expires_at);

CREATE INDEX IF NOT EXISTS idx_thought_transient_agent
  ON singularity.thought_transient(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_thought_transient_importance
  ON singularity.thought_transient(agent_id, importance_score DESC);

CREATE TABLE IF NOT EXISTS singularity.dream_state (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          VARCHAR(255) NOT NULL UNIQUE,
  version           INTEGER      NOT NULL DEFAULT 1,
  dream_started_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  compressed_memory TEXT         NOT NULL,
  pending_tasks     JSONB        DEFAULT '[]'::jsonb,
  goal_stack        JSONB        DEFAULT '[]'::jsonb,
  checksum          VARCHAR(32)  NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dream_state_agent
  ON singularity.dream_state(agent_id);

-- Comments
COMMENT ON TABLE singularity.thought_transient IS
  'Ephemeral thought storage with 24-hour TTL. Part of Singularity Memory Infrastructure (Phase 5).';
COMMENT ON TABLE singularity.dream_state IS
  'Agent cognitive state persistence for graceful shutdown/restart. Part of Singularity Cognitive Engine (Phase 2).';


-- ═══════════════════════════════════════════════════════════════════════════
-- §8  Identity — Tenants & Users
-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 009_identity_schema.sql (from 001)

CREATE TABLE IF NOT EXISTS identity.tenants (
  id         VARCHAR(50)  PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  status     VARCHAR(50)  NOT NULL,  -- active, suspended, provisioning
  tier       VARCHAR(50)  NOT NULL,  -- free, pro, enterprise
  settings   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL,

  CONSTRAINT uq_tenants_name UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS identity.users (
  id           VARCHAR(50)  PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  name         VARCHAR(255) NOT NULL,
  role         VARCHAR(50)  NOT NULL,  -- user, admin, system
  status       VARCHAR(50)  NOT NULL,  -- active, suspended, pending
  tenant_id    VARCHAR(50)  NOT NULL,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_at   TIMESTAMP WITH TIME ZONE NOT NULL,
  last_login_at TIMESTAMP WITH TIME ZONE,
  metadata     JSONB,

  CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id)
    REFERENCES identity.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT uq_users_email UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id
  ON identity.users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email
  ON identity.users(email);
CREATE INDEX IF NOT EXISTS idx_tenants_name
  ON identity.tenants(name);


-- ═══════════════════════════════════════════════════════════════════════════
-- §9  Memory Governance — Quota Overrides
-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 004_create_memory_quota_overrides.sql (from 001)

CREATE TABLE IF NOT EXISTS memory.quota_overrides (
  tenant_id                      VARCHAR(255) PRIMARY KEY,
  max_active_sessions            INTEGER,
  max_storage_bytes              BIGINT,
  max_context_tokens_per_session INTEGER,
  max_messages_per_session       INTEGER,
  plan_tier_override             VARCHAR(50) CHECK (plan_tier_override IN ('free','pro','enterprise')),
  expires_at                     TIMESTAMPTZ,
  notes                          TEXT,
  created_by                     VARCHAR(255),
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quota_overrides_expires_at
  ON memory.quota_overrides (expires_at) WHERE expires_at IS NOT NULL;

-- Auto-update trigger for updated_at
CREATE OR REPLACE FUNCTION memory.trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_quota_overrides_updated_at ON memory.quota_overrides;
CREATE TRIGGER set_quota_overrides_updated_at
  BEFORE UPDATE ON memory.quota_overrides
  FOR EACH ROW
  EXECUTE FUNCTION memory.trigger_set_updated_at();

COMMENT ON TABLE memory.quota_overrides IS
  'Runtime quota overrides per tenant for Memory Governance (MEM-NEXT.1)';


-- ═══════════════════════════════════════════════════════════════════════════
-- §10  Public Tables
-- ═══════════════════════════════════════════════════════════════════════════

-- 10.1 Long-Term Memories (from 003 + 005)
CREATE TABLE IF NOT EXISTS long_term_memories (
  id            UUID         PRIMARY KEY,
  tenant_id     VARCHAR(255) NOT NULL,
  user_id       VARCHAR(255) NOT NULL,
  content       TEXT         NOT NULL,
  type          VARCHAR(50)  NOT NULL DEFAULT 'semantical',
  metadata      JSONB        DEFAULT '{}',
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  search_vector TSVECTOR     GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);

-- Add embedding column (pgvector) — idempotent
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'long_term_memories' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE long_term_memories ADD COLUMN embedding vector(1536);
  END IF;
END $$;

-- Add search_vector if missing on legacy tables without GENERATED column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'long_term_memories' AND column_name = 'search_vector'
  ) THEN
    ALTER TABLE long_term_memories
      ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
  END IF;
END $$;

-- The english dictionary drops Cyrillic. Rebuild once when an older column still uses it.
DO $$
DECLARE
  expression text;
BEGIN
  SELECT pg_get_expr(ad.adbin, ad.adrelid) INTO expression
  FROM pg_attrdef ad
  JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'long_term_memories' AND a.attname = 'search_vector';
  IF expression IS NOT NULL AND position('english' in expression) > 0 THEN
    ALTER TABLE long_term_memories DROP COLUMN search_vector;
    ALTER TABLE long_term_memories
      ADD COLUMN search_vector tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ltm_search_vector
  ON long_term_memories USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_ltm_tenant_user
  ON long_term_memories (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_ltm_type
  ON long_term_memories (type);

CREATE INDEX IF NOT EXISTS idx_ltm_embedding_hnsw
  ON long_term_memories USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_ltm_tenant_user_created
  ON long_term_memories (tenant_id, user_id, created_at DESC);

-- 10.2 Memory Vectors — PgVectorStore (from 011)
CREATE TABLE IF NOT EXISTS memory_vectors (
  id         TEXT           NOT NULL,
  embedding  vector(1536)   NOT NULL,
  metadata   JSONB,
  namespace  TEXT           NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, namespace)
);

CREATE INDEX IF NOT EXISTS idx_memory_vectors_hnsw
  ON memory_vectors USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_memory_vectors_metadata
  ON memory_vectors USING GIN (metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_memory_vectors_namespace
  ON memory_vectors (namespace);

-- 10.3 Savepoint Support (from 010)
CREATE TABLE IF NOT EXISTS savepoint_support (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  savepoint_name         VARCHAR(255) NOT NULL,
  parent_transaction_id  VARCHAR(255) NOT NULL,
  status                 VARCHAR(50)  NOT NULL DEFAULT 'active',
  depth                  INTEGER      NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  released_at            TIMESTAMPTZ,
  rolled_back_at         TIMESTAMPTZ,
  metadata               JSONB        DEFAULT '{}'::jsonb,

  CONSTRAINT chk_savepoint_status         CHECK (status IN ('active','released','rolled_back')),
  CONSTRAINT chk_savepoint_depth          CHECK (depth >= 0),
  CONSTRAINT chk_savepoint_name_not_empty CHECK (LENGTH(TRIM(savepoint_name)) > 0),
  CONSTRAINT chk_parent_tx_not_empty      CHECK (LENGTH(TRIM(parent_transaction_id)) > 0)
);

-- Unique savepoint name within a transaction
CREATE UNIQUE INDEX IF NOT EXISTS idx_savepoint_support_unique_name_per_tx
  ON savepoint_support(parent_transaction_id, savepoint_name);

-- Time-based queries (cleanup, monitoring)
CREATE INDEX IF NOT EXISTS idx_savepoint_support_created_at
  ON savepoint_support(created_at DESC);

-- Active savepoints by transaction (partial index)
CREATE INDEX IF NOT EXISTS idx_savepoint_support_active
  ON savepoint_support(parent_transaction_id, status, created_at DESC)
  WHERE status = 'active';

-- Comments
COMMENT ON TABLE savepoint_support IS
  'Tracks savepoint metadata for nested transaction support. Part of Unit of Work SAVEPOINT strategy (P3-ENH-003).';
COMMENT ON COLUMN savepoint_support.savepoint_name IS
  'The PostgreSQL savepoint identifier (e.g., sp_0_abc12345).';
COMMENT ON COLUMN savepoint_support.parent_transaction_id IS
  'The parent transaction ID that this savepoint belongs to.';
COMMENT ON COLUMN savepoint_support.status IS
  'Current status: active (in progress), released (committed), rolled_back (aborted).';
COMMENT ON COLUMN savepoint_support.depth IS
  'Nesting depth of this savepoint (0 = first level, 1 = second level, etc.).';
COMMENT ON COLUMN savepoint_support.released_at IS
  'Timestamp when the savepoint was released (committed).';
COMMENT ON COLUMN savepoint_support.rolled_back_at IS
  'Timestamp when the savepoint was rolled back.';
COMMENT ON COLUMN savepoint_support.metadata IS
  'Additional metadata for debugging and auditing (e.g., operation name, correlation ID).';

-- 10.4 Tables the process writes and does not create itself
CREATE TABLE IF NOT EXISTS research_reports (
  id           VARCHAR(255) PRIMARY KEY,
  topic        TEXT         NOT NULL,
  status       VARCHAR(32)  NOT NULL,
  created_by   VARCHAR(255) NOT NULL,
  version      INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT research_reports_status_check CHECK (
    status IN ('draft', 'in_progress', 'completed', 'failed', 'deleted')
  )
);

CREATE INDEX IF NOT EXISTS idx_research_reports_status
  ON research_reports (status);

CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT         PRIMARY KEY,
  prefix     TEXT         NOT NULL,
  hash       TEXT         NOT NULL,
  owner_id   TEXT         NOT NULL,
  tenant_id  TEXT,
  scopes     TEXT[]       NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys (owner_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cb_state (
  key        TEXT        PRIMARY KEY,
  state      TEXT        NOT NULL,
  metrics    JSONB       NOT NULL,
  config     JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS command_queue (
  id          TEXT        PRIMARY KEY,
  lane        TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'pending',
  attempts    INT         NOT NULL DEFAULT 0,
  priority    INT         NOT NULL DEFAULT 0,
  metadata    JSONB,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cq_lane_status
  ON command_queue (lane, status, priority, enqueued_at);

-- 10.5 Feature Flags (from 054)
CREATE TABLE IF NOT EXISTS app_feature_flags (
  id         TEXT        PRIMARY KEY,
  flags      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- §11  Archive Legacy Tables
-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 020_archive_legacy_tables.sql (from 001)
-- Renames obsolete tables to archive_* prefix. No-op when already archived.

-- Only an old table is archived. The current conversations table has participants,
-- and the current messages table has token_count. Re-running must not rename those.
DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='conversations')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='conversations' AND column_name='participants'
     ) THEN
    ALTER TABLE public.conversations RENAME TO archive_conversations;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='messages')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='messages' AND column_name='token_count'
     ) THEN
    ALTER TABLE public.messages RENAME TO archive_messages;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='summary_vectors') THEN
    ALTER TABLE public.summary_vectors RENAME TO archive_summary_vectors;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- §12  Cleanup — Drop Orphaned Objects & Redundant Indexes
-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 055_drop_events_v2.sql + 060_payload_uri_and_index_cleanup.sql

-- Drop only a plain leftover. A partitioned events_v2 is the live cutover table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'event_store'
      AND c.relname = 'events_v2'
      AND c.relkind = 'r'
  ) THEN
    DROP TABLE event_store.events_v2 CASCADE;
  END IF;
END $$;

-- Drop redundant B-Tree indexes (subsumed by UNIQUE indexes above)
-- Safe to run on both fresh and existing databases.
DROP INDEX IF EXISTS event_store.idx_events_aggregate;
DROP INDEX IF EXISTS public.idx_savepoint_support_parent_tx;
DROP INDEX IF EXISTS public.idx_savepoint_support_status;


-- ═══════════════════════════════════════════════════════════════════════════
-- §13  Objects that used to be later files
-- ═══════════════════════════════════════════════════════════════════════════
-- Folded here so a new database runs one script: scheduling, ACP sessions,
-- consumer dedup, memory facts, and the conversation read model.
-- The archive step above runs first and ignores these tables once they exist.

CREATE SCHEMA IF NOT EXISTS scheduling;

CREATE TABLE IF NOT EXISTS scheduling.cron_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  schedule JSONB NOT NULL,
  handler VARCHAR(255) NOT NULL,
  payload JSONB DEFAULT '{}',
  state VARCHAR(20) NOT NULL DEFAULT 'active',
  priority INTEGER NOT NULL DEFAULT 100,
  max_runs INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run
  ON scheduling.cron_jobs(next_run_at)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS scheduling.cron_run_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES scheduling.cron_jobs(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL,
  duration_ms INTEGER,
  error TEXT,
  result JSONB
);

CREATE INDEX IF NOT EXISTS idx_cron_run_log_job
  ON scheduling.cron_run_log(job_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.acp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(64) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'init',
  transport VARCHAR(20) NOT NULL DEFAULT 'http',
  metadata JSONB DEFAULT '{}',
  turns INTEGER NOT NULL DEFAULT 0,
  last_turn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_acp_sessions_tenant ON public.acp_sessions(tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_acp_sessions_agent ON public.acp_sessions(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS processed_events (
  consumer     TEXT        NOT NULL,
  event_id     TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_events_processed_at
  ON processed_events (processed_at);

CREATE TABLE IF NOT EXISTS memory_facts (
  id              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       VARCHAR(255)     NOT NULL,
  user_id         VARCHAR(255)     NOT NULL,
  source          TEXT             NOT NULL,
  relationship    TEXT             NOT NULL,
  destination     TEXT             NOT NULL,
  weight          DOUBLE PRECISION NOT NULL DEFAULT 1,
  valid_from      TIMESTAMPTZ      NULL,
  valid_to        TIMESTAMPTZ      NULL,
  recorded_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
  invalidated_at  TIMESTAMPTZ      NULL,
  superseded_by   UUID             NULL REFERENCES memory_facts (id),
  source_event_id TEXT             NOT NULL,
  CONSTRAINT memory_facts_valid_range CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CONSTRAINT memory_facts_closed_after_recorded CHECK (invalidated_at IS NULL OR invalidated_at >= recorded_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_facts_open_triple
  ON memory_facts (tenant_id, user_id, source, relationship, destination)
  WHERE invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_facts_open_source
  ON memory_facts (tenant_id, user_id, source)
  WHERE invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_facts_open_destination
  ON memory_facts (tenant_id, user_id, destination)
  WHERE invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_facts_source_event
  ON memory_facts (source_event_id);

CREATE TABLE IF NOT EXISTS conversations (
  id            VARCHAR(255) PRIMARY KEY,
  created_by    VARCHAR(255) NOT NULL,
  participants  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  status        VARCHAR(20)  NOT NULL DEFAULT 'active',
  session_state VARCHAR(32),
  version       INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  metadata      JSONB,
  CONSTRAINT conversations_status_check CHECK (status IN ('active', 'archived', 'deleted')),
  CONSTRAINT conversations_session_state_check CHECK (
    session_state IS NULL
    OR session_state IN ('initializing', 'active', 'consolidating', 'archived', 'error')
  )
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_state VARCHAR(32);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'participants' AND udt_name = 'text'
  ) THEN
    ALTER TABLE conversations
      ALTER COLUMN participants TYPE jsonb USING participants::jsonb;
  END IF;
END $$;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_session_state_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_session_state_check
  CHECK (
    session_state IS NULL
    OR session_state IN ('initializing', 'active', 'consolidating', 'archived', 'error')
  );

CREATE INDEX IF NOT EXISTS idx_conversations_created_by ON conversations (created_by);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations (status);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   VARCHAR(255) NOT NULL REFERENCES conversations (id),
  role              TEXT,
  author_id         TEXT,
  content           TEXT,
  message_type      TEXT,
  parent_message_id TEXT,
  created_at        TIMESTAMPTZ,
  metadata          JSONB,
  token_count       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);
