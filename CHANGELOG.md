# Changelog

## 4.7.0

- An MRI review stores the authenticated user as the reviewer id. A `reviewerId` in the body is not stored. A review without an authenticated user answers 401. The clinical role stays the text the caller sends. MP-K41. `tests/unit/mri-review-identity.test.ts`.
- The ingress limiter keys a request that carries `Authorization` by a hash of that header, so two credentials on one address do not share a bucket. A request without the header still keys by `req.ip`. MP-K26. `tests/unit/rate-limiter-penalty.test.ts`.

## 4.6.0

- A document URL the SSRF guard blocks answers 400 from ingestion. A private literal host is refused before the HTTP client runs. An unexpected ingestion failure stays 500. V-46, MP-K59. `tests/unit/ingestion-ssrf-status.test.ts`.
- `DB_SSL=true` verifies the PostgreSQL server certificate. `DB_SSL_REJECT_UNAUTHORIZED=false` is the explicit opt-out. MP-K34. `tests/unit/pg-ssl-config.test.ts`.

## 4.5.0

- `USE_MOCK_AI=true` makes `LLMAdapterFactory` return a local adapter that does not call a provider. The text is empty and `metadata.mock` is true. Without the flag and without a key the factory still throws. MP-K35. `tests/unit/llm-adapter-factory-mock.test.ts`.
- `GET /health/migration` requires the same authentication as `/health/detailed`. It no longer answers to an anonymous caller. On the integration job the domains-off walk is 50 routes and 44 protected; with every domain on it is 58 and 52. `tests/unit/health-migration-auth.test.ts`.
- The ingress penalty ban of ten minutes runs only when `TRUST_PROXY` is set. `TRUST_PROXY` is now part of the configuration schema, so Express can trust the proxy hop. Without it, the shared address still receives 429 and is not banned. MP-K26. `tests/unit/rate-limiter-penalty.test.ts`.
- The resolve-all ceiling is `IUnitOfWork` and `ISandboxPool`. Integration run 42263561228 failed those two in every mode and resolved the other 25 names from the previous list.

## 4.4.0

- The x402 payment adapters and payment services are imported only when `MODULE_X402_ENABLED` is true. With the flag unset they are not in the process module cache. A2A task running stays loaded. Sales, HR, healthcare, and research are still imported while off. RSS was not measured. ADR-0005, T2.1 step 2. `tests/unit/x402-lazy-import.test.ts`.

## 4.3.0

Audit of 2.15.0..4.2.0. Every fix below has a test that fails on 4.2.0.

- Security: the default Streams bus passes `REDIS_TLS` to its Redis client. From 3.0.0 it dropped it: a TLS-only Redis was unreachable, and a server that also accepts plain TCP got the password and every event unencrypted. MP-K49. `tests/unit/event-bus-transport.test.ts`.
- A stream entry the bus cannot parse goes to the dead-letter stream on its first delivery. It used to stay pending and stop every later entry of that stream. MP-K50.
- Retries count the delivery number in the pending entries list, not in process memory. An entry whose handler stopped the process `EVENT_BUS_STREAM_MAX_DELIVERIES` times goes to the dead-letter stream without running again; before, every restart ran it again. MP-K51.
- Hard cap for `ACKED`: every 100 publishes to a stream the bus checks its length; above `EVENT_BUS_STREAM_HARD_MAXLEN` (new, default 10 x `EVENT_BUS_STREAM_MAXLEN`) it runs `XTRIM MAXLEN ~ DELREF`, which drops the oldest entries a stopped group never acknowledged, counts them in `event_bus_stream_forced_trim_entries_total{stream}`, and logs an error. Before, such a stream grew without bound. A failed check does not fail the publish. MP-K52.
- A Redis that refuses or renames `INFO` no longer stops the start: the bus warns and adds entries without `ACKED` and `IDMP`. Another `INFO` failure, such as a dropped connection, still stops it. MP-K53.
- `EVENT_BUS_STREAM_MAXLEN`, `EVENT_BUS_STREAM_HARD_MAXLEN`, `EVENT_BUS_STREAM_MAX_DELIVERIES`, `EVENT_BUS_STREAM_MIN_IDLE_MS` (0 allowed), and `EVENT_BUS_STREAM_MAX_POLL_MS` must be positive integers, or the start fails with the setting's name. `10k` used to start and fail every publish. MP-K54.
- An idle bus sleeps longer after each empty read, up to `EVENT_BUS_STREAM_MAX_POLL_MS` (new, default 1000). Ten subscribed event types sent 376 Redis commands a second per process with nothing to read, now 20. A delivery, a subscribe, or a local publish of a read type wakes it. MP-K55.
- `close()` removes the process's consumer from each group when it holds no pending entry. MP-K56.
- `IDeepResearchService` is registered only with `MODULE_RESEARCH_ENABLED=true`. From 4.0.0 it was registered without the research domain and every resolve failed. The resolve-all gate now fails on a missing dependency even for a budgeted token, and CI runs it a third time with a placeholder model key: with the domains off 2 tokens fail there, against 23 without a key, where MP-K35 fails first. MP-K57. `tests/unit/ci-gates.test.ts`.
- `PostgresResearchReportRepository.find` returns at most 100 reports a page and rebuilds them four at a time. MP-K58.
- `runKernel()` logs which product domains are on.
- ADR-0004 states what 3.0.0 changed for several processes: Pub/Sub delivered every event to every process, a consumer group delivers it to one of them.
- Dependencies, from the open Dependabot pull requests: OpenTelemetry JS 3.0 as one family (`@opentelemetry/sdk-node` and both OTLP HTTP exporters 0.300, `resources` and `sdk-metrics` 3.0, `api` 1.10, `auto-instrumentations-node` 0.82, `instrumentation-pino` 0.70, `semantic-conventions` 1.44). `sdk-metrics` is now declared: `instrumentation.ts` imports it. The lockfile holds one version of each core OpenTelemetry package; `initTelemetry` against a local OTLP endpoint exported traces and metrics. `ts-morph` 28 (TypeScript 6.0 inside; the AST checks of `src/infrastructure/mcp/audit/ast-checker.ts` ran on this tree), `pgvector` 0.3 (nothing imports it), `husky` 9 (nothing runs it). Actions: `actions/setup-node` 7.1.0, `github/codeql-action` init and analyze 4.39.1.
- The Dependency Review workflow warns and stops while the repository's dependency graph is off; it failed on every pull request without reviewing anything. Any other API error still fails it. `npm audit --omit=dev --audit-level=high` in `ci` gates production dependencies either way.
- The plan status keeps the 4.0.0 count of 327 registered tokens with the domains off separate from the 4.3.0 gate, which reported 326 after `IDeepResearchService` stopped being registered in that mode. `close()` deleting an idle consumer does not cover a killed process: that consumer and its pending entries remain (MP-K56). `CITATION.cff` names 4.3.0.
- The public description of `IDMP` names Redis's default window (the last 100 ids, 100 seconds). Outside it a repeated publish appends a second entry. ADR-0004 cites the `XADD` reference for option order and for `ACKED` leaving a stream longer than `MAXLEN`. ADR-0005 cites Fowler's strangler fig (2004) for the flag step. `docs/research/long-running-case.md` maps Helland (2012) and Kleppmann (2017) onto that bus.

## 4.2.0

- Typed DI tokens (T2.3, step 1). `InjectionToken<T>` is a string or symbol that names the type it resolves to; `createToken<T>(name)` makes one, `container.inject(token)` returns that type without a type argument, `container.provide(token, factory)` checks what the factory returns. At run time a token is the same string, so typed and string calls share one registration and modules can move one at a time. `KernelTokens` types seven public ports. The package root exports `createToken`, `InjectionToken`, `TokenType`, and `KernelTokens`. The guarded extension container treats `provide` like `register`. `npm run typecheck` compiles `src/core/di/injection-token.typecheck.ts`, where a wrong type, a wrong factory, and a bare string must stay compile errors. CI fails when `resolve()` calls with a string literal in `src` exceed 204. MP-K48. `tests/unit/injection-token.test.ts`.

## 4.1.0

- `OutboxSaveOptions.expectedAggregateVersions`: one batch checks an expected version for each listed aggregate under its lock, then writes every event, or throws `ConcurrencyError` and writes none. This is a multi-stream append with an expected revision per stream, as KurrentDB 25.1 added. `PostgresUnitOfWork` uses it: an aggregate whose events carry versions from 1 up without a gap must find the journal at the first version minus one. Before, two units of work decided on one version both committed, and a conflict on one aggregate did not stop the others. Events with version 0 are still appended after the head. MP-K40. `tests/integration/unit-of-work-versions.test.ts`, `tests/unit/unit-of-work-heads.test.ts`.

## 4.0.1

- `PostgresResearchReportRepository.findById` and `find` rebuild each report from the journal. Both called `restoreFromHistory` with no events, which throws, so they returned `CONNECTION_ERROR` for every saved report. MP-K44. `tests/integration/repository-version-race.test.ts`.

## 4.0.0

- Breaking: sales, HR, healthcare, research, and x402 are off unless the deployment sets `MODULE_<NAME>_ENABLED=true` (`MODULE_SALES_ENABLED`, `MODULE_HR_ENABLED`, `MODULE_HEALTHCARE_ENABLED`, `MODULE_RESEARCH_ENABLED`, `MODULE_X402_ENABLED`). The research and healthcare flags existed and defaulted to on. Off means no use cases, controllers, services, workers, or routes for that domain. With the flags unset the kernel registers 327 DI tokens instead of 367 and mounts 50 routes instead of 58; with every flag on it is unchanged. Loaded modules and RSS did not move: the code is still imported. ADR-0005. MP-K38. `tests/unit/product-domains.test.ts`.
- CI runs the resolve-all and route gates a second time with every product domain on.

## 3.0.1

- A kernel pool no longer turns a server error during shutdown into an uncaught exception. pg-pool resolves `end()` before its removed clients have closed their sockets, and the kernel removed its `error` listener before `end()`. `PostgresAdapter`, the outbox, the event store, the MAS store, and the processed-event claim now end their pools through `endPool`, which keeps a no-op listener and returns once every client is removed. The repository race test, which failed in 1 of 4 runs, passed 10 of 10. MP-K47. `tests/unit/end-pool.test.ts`.

## 3.0.0

- Breaking: an empty `EVENT_BUS_TRANSPORT` selects Redis Streams. Before, it selected Pub/Sub, which drops a publish that reaches no subscriber, so the outbox marked rows PUBLISHED that no consumer ever read. A process that subscribed to the kernel's Pub/Sub channels from outside now joins a consumer group on `<prefix>stream:<eventType>`, or the deployment sets `EVENT_BUS_TRANSPORT=pubsub`. ADR-0004. MP-K22. `tests/unit/event-bus-transport.test.ts`.
- The streams bus reads `redis_version` when it connects. From Redis 8.2 it trims with `ACKED`, so the cap of `EVENT_BUS_STREAM_MAXLEN` entries does not remove an entry a consumer group has not acknowledged. On Redis 8.10.3 a group that read nothing kept 400 of 400 entries under a cap of 10; the old call kept 100. From Redis 8.6 it adds each event with `IDMP <prefix>events <eventId>`, so an outbox retry of one row adds one entry; a dead-letter replay still adds a new one. Older servers, and forks that report an older version, keep the 2.x call. `tests/integration/redis-streams-bus.test.ts`.
- CI runs the integration job on `redis:7-alpine` and `redis:8.10-alpine`.

## 2.18.3

- `follow-redirects` 1.16.2 (through `@slack/bolt` → `axios`) and `systeminformation` 5.33.19 (through `@opentelemetry/auto-instrumentations-node`). The production audit reported two high advisories in 1.16.1 and 5.33.15 (GHSA-mrwp-f3q8-3g9p, GHSA-3f7j-7jwc-fxfj), so the CI audit step failed on an unchanged tree. Only those two entries of `package-lock.json` moved. `npm audit --omit=dev --audit-level=high` exits 0. Seven moderate advisories remain (`glob`/`minimatch` under `ts-morph` and `gaxios`); their fix is a major `glob`.

## 2.18.2

- `RedisAdapter.existsMany` answers for each key. It sent one `EXISTS` with all keys, which returns how many exist, and read that count as a bit mask: with `a` and `b` present it answered `[false, true]`. It now sends one `EXISTS` per key on the same connection. MP-K46. `tests/integration/redis-adapter-exists.test.ts`.

## 2.18.1

- `StructuredLogger` writes only records at or above `LOG_LEVEL`. Without it, or with another value, the default is debug outside production and info in production, as in `PinoLoggerAdapter`. An error is always written. MP-K25. `tests/unit/structured-logger-level.test.ts`.
- An error-like object without a stack is logged without one. The logger gave it a new stack that pointed at the logger itself, so a 401 still logged a stack after `LoggingAspect` dropped it. On the routes gate, a 401 cost 1752 bytes of log before this cut, 581 with `LOG_LEVEL=info`, and 829 without `LOG_LEVEL` in development.

## 2.18.0

- `RetryAspect` repeats a method only when the method is marked idempotent, and only after a transient error. The class lists it in `static readonly idempotentMethods`, or the registration sets `idempotent: true` in `aspectOptions.metadata` or `aspectOptions.methodMetadata.<method>.metadata`. A read-looking name (`get*`, `find*`, `list*`, ...) no longer counts: the audit found 32 such methods that write. This also applies to project classes named `*Adapter`, `*Repository`, or `*HttpClient`. `ContainerRegistryAdapter.listTags` and `getSourceUrl` are marked; nothing else in this tree is. V-03, MP-K13. `tests/unit/retry-aspect.test.ts`, `docs/extensions.md`.

## 2.17.0

- `getCommittedEventsAfter` reports `heldSince`: the timestamp of the oldest committed event it could not return because an older transaction is still open. The query reads one row past the page to see it. MP-K23. `tests/integration/event-commit-order.test.ts`.
- `SemanticEmbeddingWorker` no longer falls back to a gsn cursor. On a store that cannot read in commit order it logs an error and does not read. It sets `event_consumer_lag_seconds{consumer}` to the age of the oldest committed event it has not processed, including a held one, and to 0 when nothing waits. No kernel consumer reads by gsn now. `getEventsByGsnRange` is marked for diagnostics. `tests/unit/semantic-embedding-worker.test.ts`.
- `docs/limitations.md` names `idle_in_transaction_session_timeout` as a role setting; this tree does not set it.

## 2.16.3

- `PostgresAdapter.transaction` runs at the isolation level it was asked for. `SET TRANSACTION ISOLATION LEVEL` was sent before `BEGIN`, where PostgreSQL ignores it, so `SERIALIZABLE` ran at READ COMMITTED. The level is now part of `BEGIN`. The transaction timeout is `SET LOCAL`; a plain `SET` before `BEGIN` stayed on the pooled connection and the next transaction on it inherited the timeout. MP-K45. `tests/integration/postgres-adapter-transaction.test.ts`.

## 2.16.2

- Two saves of one conversation or one research report at the same version no longer both commit. Each repository compared the read-model version, but both transactions could read it before either committed; the second then overwrote the read model, and the outbox numbered its events after the first writer's. In ten concurrent pairs, every pair committed twice. The repositories now take the aggregate's transaction lock, the one the outbox takes before it numbers events, before they read the version. Now exactly one save of each pair commits and the other returns `CONFLICT`. `PostgresUnitOfWork` is unchanged. MP-K40. `tests/integration/repository-version-race.test.ts`.
- `PostgresResearchReportRepository.findById` always fails; recorded as MP-K44. The race test loads reports with `rehydrate`.

## 2.16.1

- Processes that start in one working directory no longer fail the critical filesystem check against each other. The write probe was named by `Date.now()`: two starts in the same millisecond wrote one file, one unlinked it, and the other reported the directory as not writable. One of 20 parallel boots on one database stopped that way. The probe now carries the pid and a random UUID and is created with `wx`. MP-K43. `tests/unit/filesystem-check.test.ts`.

## 2.16.0

- `003_skill_graph_finops.sql` creates the four `skill_*` tables, their three indexes, the `finops` schema, and `finops.agent_spend_state`. `001` and `002` are unchanged, so a database that applied them accepts this file. With `DB_RUNTIME_DDL` unset, the skill relation graph, the finops spend store, the feature-flag store, and the MAS read models check their tables and do not create them; the last two use tables `001_consolidated.sql` already has. Before this cut, the first use of those four stores on a migrated database sent 15 DDL commands. An event trigger on `ddl_command_start` now records none from any kernel store. MP-K24. `tests/integration/runtime-tables.test.ts`, `tests/unit/runtime-ddl.test.ts`.
- With `DB_RUNTIME_DDL=true` the MAS read models are created with text ids, as in the baseline. They were `uuid`, which rejects ids such as `tenant-1`.

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
