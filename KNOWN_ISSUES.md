# Known issues

Rows here are limits of this kernel cut. A closed row stays, so the history of the check is still visible.

| ID | Status | Summary | Check |
| --- | --- | --- | --- |
| MP-K1 | closed | Separate files `010` and `011` could report success while dropping the real statements, because a leading `--` comment or the word `CONCURRENTLY` inside a comment changed the runner. Those statements now live in `001_consolidated.sql` as ordinary indexes and one transaction. Comments are still ignored when a project file uses a concurrent index. | `tests/unit/infrastructure/database/migration-runner.test.ts` |
| MP-K2 | closed | Standard plugins shipped as `manifest.ts` only. The loader reads `manifest.json` and skipped every directory. Each plugin now has `manifest.json` with `main: index.js`, and the build copies those files into `dist/plugins`. | `tests/unit/infrastructure/plugins/standard-plugin-manifests.test.ts` |
| MP-K3 | open | `web-browser` loads `puppeteer` on the first browser tool call, not when the process starts. A failed import is logged by the plugin loader only if the module itself fails. This cut does not prove that a browser binary is present. | `src/plugins/standard/web-browser/index.ts` |
| MP-K4 | open | Documentation MCP tools look for `KNOWN_BUGS.md`, `CONTEXT_INDEX.json`, and `AI_CHEATSHEET.md` in the process tree. Those files are not part of this cut. The tools start without that text. | `docs/limitations.md` |
| MP-K5 | open | Installing this package with `npm install github:KonkovDV/Vesta#<sha>` has not been run. The remote is https://github.com/KonkovDV/Vesta. Evidence so far is a local build of this tree, not a git install. | `AUDIT.md` |
| MP-K6 | accepted | The migration runner uses advisory lock id `1337`. Two different programs that pick the same id will queue behind each other. A failed file does not stop the later files; the process exit code is 1 when any file failed. | `src/infrastructure/database/migration-runner.ts` |
| MP-K7 | closed | An overdue one-shot was advanced as if it had already run, so the only firing was deleted after an outage longer than the catch-up window. `overdueSlotDecision` still runs kind `at`. Repeating jobs keep the window. | `tests/unit/domain/scheduling/CronScheduleComputer.test.ts` |
| MP-K8 | closed | `requiresApproval` stopped the body in `AgentRunService` only. `ToolRegistry.execute` ran the body anyway, and a batch recorded the call as `allow`. The registry now requires `approvalGranted`. The batch records `ask` and does not call the tool. | `tests/unit/application/agents/services/tool-registry.test.ts` |
