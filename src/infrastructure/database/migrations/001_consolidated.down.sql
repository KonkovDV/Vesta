-- ============================================================================
-- MicroPhoenix — Consolidated Database Rollback
-- ============================================================================
-- Reverses 001_consolidated.sql
-- WARNING: This drops ALL application tables and schemas. Data will be lost.
-- Order: child tables first (FK deps), then parent tables, then schemas.
-- ============================================================================

-- §12 Cleanup rollback — restore dropped objects is not possible (data lost)

-- §11 Archive Legacy — cannot reliably restore original names (no-op)

-- §13 Later objects folded into the baseline
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS memory_facts;
DROP TABLE IF EXISTS processed_events;
DROP TABLE IF EXISTS public.acp_sessions;
DROP TABLE IF EXISTS scheduling.cron_run_log;
DROP TABLE IF EXISTS scheduling.cron_jobs;
DROP SCHEMA IF EXISTS scheduling CASCADE;

-- §10 Public Tables
DROP TABLE IF EXISTS command_queue;
DROP TABLE IF EXISTS cb_state;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS research_reports;
DROP TABLE IF EXISTS app_feature_flags;
DROP TABLE IF EXISTS savepoint_support;
DROP TABLE IF EXISTS memory_vectors;
DROP TABLE IF EXISTS long_term_memories;

-- §9 Memory Governance
DROP TRIGGER IF EXISTS set_quota_overrides_updated_at ON memory.quota_overrides;
DROP FUNCTION IF EXISTS memory.trigger_set_updated_at();
DROP TABLE IF EXISTS memory.quota_overrides;

-- §8 Identity (users references tenants — drop users first)
DROP TABLE IF EXISTS identity.users;
DROP TABLE IF EXISTS identity.tenants;

-- §7 Singularity
DROP TABLE IF EXISTS singularity.dream_state;
DROP TABLE IF EXISTS singularity.thought_transient;

-- §6 MAS Runtime
DROP TABLE IF EXISTS mas_runtime.mas_task_stats_read_model;
DROP TABLE IF EXISTS mas_runtime.mas_session_read_model;

-- §5 MAS (respect FK: children first)
DROP TABLE IF EXISTS mas.swarm_participants;
DROP TABLE IF EXISTS mas.swarms;
DROP TABLE IF EXISTS mas.team_members;
DROP TABLE IF EXISTS mas.teams;
DROP TABLE IF EXISTS mas.event_outbox;
DROP TABLE IF EXISTS mas.execution_steps;
DROP TABLE IF EXISTS mas.task_executions;

-- §4 Outbox
DROP TABLE IF EXISTS outbox.dead_letter_queue;
DROP TABLE IF EXISTS outbox.messages;

-- §3 Event Store
DROP TABLE IF EXISTS event_store.consumer_cursors;
DROP TABLE IF EXISTS event_store.snapshots;
DROP TABLE IF EXISTS event_store.events;
DROP SEQUENCE IF EXISTS event_store_events_gsn_seq;

-- §2 Schemas
DROP SCHEMA IF EXISTS identity CASCADE;
DROP SCHEMA IF EXISTS memory CASCADE;
DROP SCHEMA IF EXISTS singularity CASCADE;
DROP SCHEMA IF EXISTS mas_runtime CASCADE;
DROP SCHEMA IF EXISTS mas CASCADE;
DROP SCHEMA IF EXISTS outbox CASCADE;
DROP SCHEMA IF EXISTS event_store CASCADE;

-- §1 Extensions (intentionally NOT dropped — may be shared with other databases)
-- DROP EXTENSION IF EXISTS vector;
-- DROP EXTENSION IF EXISTS "uuid-ossp";
