# Limitations

This kernel is a server process and a library entry (`runKernel`). It is not a product template with a copied tree.

## Not in this repository

- The web client. It lives outside this cut.
- Plans, benchmarks, evaluation reports, and the unit-test suite of the monorepo.
- The cron timer and `overdueSlotDecision`. The port `ICronService` is here. The clock is not. MP-K9.
- Connectors to 1C, EDI, banks, courts, or a collections case. Those belong in a project repository pinned to one commit of this kernel.
- A measured model-quality claim. `USE_MOCK_AI=true` is a stub.

## Behaviour that is easy to misread

- `/health/live` means the process answers. `/health/ready` is 200 only when the event store, the bus, and the outbox are healthy and the `FF_USEREALEVENTSTORE`, `FF_USEREALEVENTBUS`, and `FF_USEREALOUTBOX` flags are on.
- Slack and S3 stay disconnected when their credentials are absent. Startup logs that and continues with local fallbacks.
- `runKernel()` throws `KernelStartError` on a failed start and removes the signal handlers it installed for that attempt. Process exit on startup failure is `src/index.ts` only. After a successful start the handlers stay, and they do exit the process.
- Project code may register new DI tokens. Registering a token the kernel already owns throws at startup. An empty extension name throws.
- The kernel ships one baseline, `001_consolidated.sql`. A second run skips it when the checksum in `microphoenix_schema_migrations` matches. Editing that file after it was applied is an error; add a new file. SQL from `--dir` runs after the baseline. Names inside one directory are sorted. A `*.down.sql` file is never applied. A failed file increments the failure count and the next file still runs. Its checksum is not stored, so the next run tries that file again. The command exits 1 if any file failed.
- A research report is restored from its snapshot and only the events after that snapshot, in one database query. The event log remains the source of truth. The database pool opens one connection during startup so the first request does not pay for a new PostgreSQL backend. If that connection fails, the process still starts and `/health/ready` reports it.
- Saving several events through the outbox writes one `INSERT` into the event table and one `INSERT` into the outbox table. A unique version conflict retries that batch. It does not leave the surrounding transaction aborted. A poll locks only the limited batch (`FOR UPDATE SKIP LOCKED` inside a materialized CTE) and publishes that batch together. One `UPDATE` marks the published rows. One `UPDATE` marks the rows that failed. A crash before the published mark leaves them `PROCESSING` until the lease expires, and the worker delivers them again. That is at-least-once delivery. The project makes the remote effect idempotent. This kernel does not provide exactly-once delivery across a network.
- While an agent run is in its loop, a cancel check asks whether an `AgentRunCancelled` event exists. It does not load the stream. A store without that probe still loads the stream.
- This cut exports `ICronService` and does not start a timer. `overdueSlotDecision` is not in this tree. `runKernel()` does not wake a one-shot job. MP-K9.
- `requiresApproval` is enforced in `ToolRegistry.execute`, which is the call that runs the tool body. The body runs only when the context has `approvalGranted: true`. `AgentRunService` sets that flag after a recorded approval of the same call. A batch whose policy returns `requiresApproval` records `ask`, leaves the batch unauthorized, and does not call the tool. `ToolProtectionAspect` is not wired into this path. A tool that returns `{ status: 'approval_required' }` has already run; that return value is not the gate.
- Reads by correlation id, causation id, event type, and GSN do not fetch `semantic_embedding`. A GSN page does not send a second query for `MAX(gsn)` when metrics are off. When metrics are on, that maximum is in the same query.
- Hybrid memory search runs the lexical scan while the query embedding is built. The text query is parsed once. Fusion is reciprocal rank fusion with k = 60. A dense search sets `hnsw.iterative_scan` and reads the nearest rows in one statement.
- `CREATE INDEX CONCURRENTLY` runs outside a transaction. The kernel baseline does not use it: on a new database a plain index inside one transaction is the faster path. The word `CONCURRENTLY` inside a comment does not select that path. Leading `--` comments are not part of the statement.
- Standard plugins load from `manifest.json` next to `index.js`. `puppeteer` is loaded on the first browser or PDF call, not at process start. A plugin that fails to import is logged and skipped. The process still starts.
- Documentation MCP tools read `KNOWN_BUGS.md`, `CONTEXT_INDEX.json` and `AI_CHEATSHEET.md` from the process tree when those files exist. This cut does not ship them. The tools continue without that text.
