# Claims

If a sentence in `README.md` disagrees with this file or with [limitations.md](limitations.md), this file and the limitations win.

These rows are claims about this source tree. They are not a deployment report and not a model score.

| ID | Claim | Where it is checked |
| --- | --- | --- |
| C1 | One process listens. `src/index.ts` calls `runKernel()`. Importing the package does not listen. | `docs/architecture.md` |
| C2 | A product pins a 40-character commit. A branch name is not a pin. | [adr/0001-kernel-as-package.md](adr/0001-kernel-as-package.md). Installing from a remote is MP-K5 and has not been run. |
| C3 | An overdue one-shot still runs once. A repeating job overdue past the catch-up window moves to the next slot. | `overdueSlotDecision` in `src/domain/scheduling/CronScheduleComputer.ts`, covered by `tests/unit/domain/scheduling/CronScheduleComputer.test.ts` and `tests/unit/infrastructure/scheduling/CronTimerManager.test.ts` |
| C4 | A tool body that requires approval does not run unless the call has `approvalGranted`. The agent loop sets that flag after a recorded approval. A batch records `ask` and skips the body. | `tests/unit/application/agents/services/tool-registry.test.ts`, `tests/unit/application/agents/AgentRunService.test.ts`, `tests/unit/agents/wave-3-adapters.test.ts` |
| C5 | The outbox delivers at least once. A crash between the bus accept and the published mark leaves the row leased, then the worker tries again. | `docs/limitations.md`. The kernel does not claim exactly-once across a network. |
| C6 | The kernel baseline is one forward file, `001_consolidated.sql`. A matching checksum skips it. A failed file does not store a checksum. | `tests/unit/infrastructure/database/migration-runner.test.ts` |

## Words that are not claims

| Word | Means | Does not mean |
| --- | --- | --- |
| `pinned` | `package.json` names a 40-character commit of this kernel | The product has been accepted by a court or a customer |
| `ready` | `/health/ready` is 200 and the three real-store flags are on | A model answered correctly |
| TRL 4 | Self-assessed laboratory component, in the sense of ISO 16290 | A certificate, a pilot, or TRL 5 |

`USE_MOCK_AI=true` is a stub. It is not a row in this table.
