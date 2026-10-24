# Changelog

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
- When the DNS guard can pin an address, document ingestion, x402 settlement, container-registry GET, outbound MCP, and A2A connect to those addresses. A redirect is pinned again. A check that only returns `isSafe` does not pin the socket. The laboratory media store is not in this cut.
