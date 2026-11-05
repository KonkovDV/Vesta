# Evidence, 2026-10-24

Outputs of the checks behind MP-K11..MP-K38. Produced on Node 24.22.1, PostgreSQL 16.15 with pgvector, Redis 7.0.15.

| File | What produced it |
| --- | --- |
| `resolve-all-baseline.txt`, `resolve-all-fixed.txt` | Kernel booted with `USE_MOCK_AI=true`, then `container.resolve()` on every registered token (commit `e6814bb`, then this cut). |
| `di-consistency.json` | Regex scan of `register(`/`resolve(`/`isRegistered(` with literal or `DI_TOKENS.*` tokens. Heuristic: registrations through helpers are missed. |
| `routes-fixed.txt` | Every route of the live Express app, requested without credentials. A 404 here can be a lost router prefix; see MP-K31/MP-K32 for the checked ones. |
| `layers.json`, `hazards.json` | ts-morph walk of all 989 files of `e6814bb`: lines, classes, functions, cross-layer imports, empty catches, child_process, setInterval without unref, SQL template interpolation (19 sites, reviewed: none injectable). |
| `01_AUDIT_REPORT_RU.md`, `02_WORK_PLAN_FOR_AI.md`, `03_findings.json` | The audit report, the work plan through T2.3, and the 51-finding register, as of 2026-10-24. Statuses in `03_findings.json` are from that day; `KNOWN_ISSUES.md` holds the current ones. |
| `04_PLAN_STATUS.md` | Each plan task checked against the tree on 2026-11-05 (4.2.0): the decisions taken for the owner, commit, test or command, what is left, sources, and the prompt for the next pass. Then the audit of 2.15.0..4.2.0 (MP-K49..MP-K58) and the runs on 4.3.0. |
