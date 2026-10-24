# Evidence, 2026-10-24

Outputs of the checks behind MP-K11..MP-K38. Produced on Node 24.22.1, PostgreSQL 16.15 with pgvector, Redis 7.0.15.

| File | What produced it |
| --- | --- |
| `resolve-all-baseline.txt`, `resolve-all-fixed.txt` | Kernel booted with `USE_MOCK_AI=true`, then `container.resolve()` on every registered token (commit `e6814bb`, then this cut). |
| `di-consistency.json` | Regex scan of `register(`/`resolve(`/`isRegistered(` with literal or `DI_TOKENS.*` tokens. Heuristic: registrations through helpers are missed. |
| `routes-fixed.txt` | Every route of the live Express app, requested without credentials. A 404 here can be a lost router prefix; see MP-K31/MP-K32 for the checked ones. |
| `layers.json`, `hazards.json` | ts-morph walk of all 989 files of `e6814bb`: lines, classes, functions, cross-layer imports, empty catches, child_process, setInterval without unref, SQL template interpolation (19 sites, reviewed: none injectable). |
| `01_AUDIT_REPORT_RU.md`, `02_WORK_PLAN_FOR_AI.md`, `03_findings.json` | The audit report, the work plan through T2.3, and the 51-finding register. Phase 1 tasks are not implemented in this tree. |
