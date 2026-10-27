# Changelog

## 2.15.0

- `runKernel()` no longer mounts `/api/mcp` after the 404 handler. That mount logged success and answered 404. A product calls `mountMcpHttp` from extension `routes`, which runs before the 404 handler. A request without a key answers 401. The tool-policy agent id stays `mcp-http-client` when the URL says `researcher-x`. MP-K31. `tests/unit/mcp-http-mount.test.ts`.

## 2.14.0

- `002_runtime_tables.sql` creates the seven `learning_*` tables, the three `error_graph_*` tables, and their HNSW indexes. `001_consolidated.sql` is unchanged, so a database that already applied it accepts this file. With `DB_RUNTIME_DDL` unset, the event store, the outbox, the MAS store, the learning stores, and the error graph check for those tables and do not create them. `DB_RUNTIME_DDL=true` restores the old statements. MP-K24. `tests/integration/runtime-tables.test.ts`.

## 2.13.0

- `EVENT_BUS_TRANSPORT=streams` appends each event to a Redis stream. A consumer that is down at publish time still reads the entry when it starts. A handler that throws leaves the entry pending, and the next consumer claims it. After a successful handler, `processed_events` records the id so that consumer does not run it again. The default remains Pub/Sub. MP-K22. `tests/integration/redis-streams-bus.test.ts`.

## 2.12.3

- Two writers that pass the same `expectedAggregateVersion` cannot both commit. The head-row lock did not see a version inserted after that row, so both writes succeeded. Writers of one aggregate now queue on a transaction lock, then read `MAX(aggregate_version)`. `tests/integration/outbox-delivery.test.ts`. MP-K40.

## 2.12.2

- CI boots the kernel on the integration job and resolves every registered token. A failing name that is not in `tests/gates/resolve-all-budget.json` fails the job. The list is a ceiling (27 names from 2026-10-24). MP-K35.
- The same job requests every walked route without a key. A status other than 401 or 403 fails unless the route is in `tests/gates/public-routes.json`. 404 is not counted as an answer. `tests/unit/ci-gates.test.ts`.

## 2.12.1

- `SELF_LLM_URL` calls `SELF_LLM_MODEL` on an OpenAI-compatible `/v1` endpoint. The old fixed name `session-self` is gone. `USE_MOCK_AI=true` still does not call that URL. `tests/unit/chat-model-selection.test.ts`. MP-K42.

## 2.12.0

- The kernel baseline is one forward file again, `001_consolidated.sql`. It includes `tx_id`, the outbox lease columns, and `event_store.consumer_cursors`. `*.down.sql` is not applied. A database that stored the 2.11.0 checksum of `001_consolidated.sql` refuses this file. That is not an in-place upgrade.

## 2.11.0

- One executor writes a run at a time. A second resume that loses the stream version stops with `AgentRunConflictError`, or returns the result when the first executor already finished. `ToolCallStarted` carries a lease, so a live body is not journaled as `outcome_unknown`. MP-K39. `tests/unit/agent-run-service.test.ts`, `tests/integration/agent-run-postgres.test.ts`.
- `saveEventsWithOutbox` accepts `expectedAggregateVersion` and throws `ConcurrencyError` instead of renumbering. Callers that omit the version still renumber. MP-K40. `tests/integration/outbox-delivery.test.ts`.
- `SemanticEmbeddingWorker` reads in commit order and stores its cursor in `event_store.consumer_cursors` (`004_consumer_cursors.sql`). MP-K23. `tests/unit/semantic-embedding-worker.test.ts`.
- Sales, HR, healthcare, and ingest require a scope. MRI review and finalize also require `healthcare.review`. Keys from `BFF_API_KEY` and `BFF_API_KEYS_CSV` have no scopes. MP-K32. `tests/unit/product-route-scopes.test.ts`.
- C3 names the outbox poll and the hourly memory purge. Those are not a cron wake-up.

## 2.10.0

Hardening cut. Each line names the check that backs it; `npm test` and `npm run test:integration` are part of this repository now.

- A kernel extension receives a guarded container view. `register` refuses any token that is already registered, whatever the global override flag says; `unregister`, `setAllowOverrides`, `clear`, `dispose` and `setAspectManager` throw. Before this cut the global container allowed overrides, so an extension could replace `IToolExecutionPolicy`. `tests/unit/kernel-extensions.test.ts`.
- `ToolRegistry.execute` validates and sanitizes the arguments first and asks the policy about those, so the policy and the body see the same object. A second tool under one name is refused; MCP discovery cannot replace a local tool. `tests/unit/tool-registry.test.ts`.
- `AgentRunService` appends `ToolCallStarted` with the stream version it read before a tool body runs. Two executors cannot both run one call; a call that was running when the process stopped is journaled as `outcome_unknown` and not repeated; calls queued behind an approval run after the decision, so the model never receives a tool call without a result. A policy that rewrites approved arguments is denied. `ToolApprovalDecided` records `decidedBy`. Model failures back off with jitter. `tests/unit/agent-run-service.test.ts`, `tests/integration/agent-run-postgres.test.ts`.
- `wrapUntrusted` escapes `<untrusted` / `</untrusted` inside tool output.
- Agent run routes record the owner on `AgentRunStarted`; `GET .../events` and `POST .../cancel` answer 404 for another principal and for an unknown run. `tests/unit/agent-run-routes.test.ts`.
- `RetryAspect` repeats only transient failures of read-only methods. Before, every `*Adapter` method (payments, tool bodies, messages) ran up to three times after any error, and every 401 took 300 ms. `tests/unit/retry-aspect.test.ts`.
- SSRF: IPv6 is parsed, IPv4-mapped and NAT64 addresses are checked as the IPv4 host they reach, and the remaining IANA special-purpose ranges are blocked. `pinnedExchange` caps the body; the pinned fetch drops credentials on a cross-origin redirect. `tests/unit/ssrf.test.ts`.
- Outbox (`002_outbox_delivery.sql`): backoff before a retry, an expired lease counts as an attempt (poison rows reach the DLQ), PUBLISHED/FAILED updates are fenced by the claim's lease token, and only the oldest open version of an aggregate is claimed. `tests/integration/outbox-delivery.test.ts`.
- `EVENT_BUS_REQUIRE_SUBSCRIBER=true` fails a Redis PUBLISH that reached no subscriber, so the outbox retries it.
- Standard plugins load (the loader had the wrong registry) but only when `STANDARD_PLUGINS` names them. `code_execute` no longer runs code in `node:vm`; `file-system` checks real paths; `web-browser` accepts only public http(s) and keeps Chrome's sandbox. `tests/unit/standard-plugins.test.ts`.
- `read_file` compares real paths and caps the size. `tests/unit/workspace-read-file.test.ts`.
- HTTP: the client id is `req.ip`, metric labels are route templates, logs drop the query string, `api_key` in the query needs `ALLOW_QUERY_API_KEY=true`. `tests/unit/http-identity.test.ts`.
- `readInt`/`readBool` accept values the schema coerced: `REDIS_PORT` and `REDIS_DB` were ignored, and the kernel did not start on a non-default Redis port. `getConfig()` is cached until `reloadConfig()`. `tests/unit/app-config.test.ts`.
- `microphoenix-migrate` stops after the first failed file (`--continue-on-error` keeps the old behaviour) and sets `lock_timeout`. `tests/unit/migration-runner.test.ts`.
- `AnthropicChatModel` keeps the cached prefix stable and sets `cache_control` breakpoints. `tests/unit/anthropic-chat-model.test.ts`.
- `LoggingAspect` traces calls at debug level; a 4xx is a warning.
- Dependencies: `npm audit --omit=dev` reports 0. multer 2, uuid 11; `module-alias` removed; `@types/*` are devDependencies.
- CI runs typecheck, unit tests on Node 24 and 26, build, the production audit, and an integration job with pgvector and Redis.
- Human approval works end to end: the policy asks for tools with external effects (`TOOL_APPROVAL_REQUIRED`), `POST /api/agents/runs/:id/approvals/:toolCallId` records the decision and resumes, `KernelExtension.toolPolicy` adds tighten-only rules. `bash`/`python` are no longer denied by the `exec` alias. MP-K27..MP-K29.
- Outbound MCP over HTTP is pinned (MP-K10). The MCP HTTP server no longer takes the policy agent id from the URL (MP-K30).
- `getCommittedEventsAfter` and migration `003_event_commit_order.sql` read the journal in commit order (MP-K23).
- `USE_MOCK_AI=true` stubs the agent loop's chat model (MP-K33). Outbox TLS verifies certificates by default (MP-K34).

## 2.9.0

First cut published as a library kernel.

- Public entry is `runKernel`. `src/index.ts` only starts the process and exits on `KernelStartError`.
- A project adds DI registrations, HTTP routes, and SQL directories without editing the kernel. A kernel DI token cannot be replaced.
- `dist/` emits declarations. `@/` aliases in `dist/` are rewritten to relative paths so the package loads from `node_modules`.
- The kernel ships one baseline, `001_consolidated.sql`. Scheduling, ACP sessions, event indexes, semantic embeddings, processed events, memory facts, conversations, and the `simple` text-search vector are in that file. A second `microphoenix-migrate` skips a file whose checksum is already in `microphoenix_schema_migrations`.
- `microphoenix-migrate` applies the baseline, then each `--dir`. A comment that mentions `CONCURRENTLY` does not drop the statements around it. A `BEGIN` inside `DO $$` does not stop the runner from wrapping the file in one transaction.
- Standard plugins ship `manifest.json` (`main: index.js`). The loader reads that file from `dist/plugins` after build. A missing `index.js` falls back to `index.ts` when the sources are what is running.
- The manifest schema and the standard plugins resolve from the package directory, not from the project working directory.
- A failed `runKernel()` removes the process handlers installed for that attempt.
- The published tree does not include `CronScheduleComputer` or a running cron timer. `ICronService` is a port only. MP-K9.
- `ToolRegistry.execute` does not run a tool when `requiresApproval` is set unless the call has `approvalGranted`. A batch records that call as `ask` and skips the body.
- When the DNS guard can pin an address, document ingestion, x402 settlement, container-registry GET, and A2A connect to those addresses. A redirect is pinned again. A check that only returns `isSafe` does not pin the socket. The laboratory media store is not in that cut. Outbound MCP in 2.9.0 does not pin; 2.10.0 does. MP-K10.
