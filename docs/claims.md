# Claims

If a sentence in `README.md` disagrees with this file or with [limitations.md](limitations.md), this file and the limitations win.

These rows are claims about this source tree. They are not a deployment report and not a model score.

| ID | Claim | Where it is checked |
| --- | --- | --- |
| C1 | One process listens. `src/index.ts` calls `runKernel()`. Importing the package does not listen. | `docs/architecture.md` |
| C2 | A product pins a 40-character commit. A branch name is not a pin. | [adr/0001-kernel-as-package.md](adr/0001-kernel-as-package.md). Installing from a remote is MP-K5 and has not been run. |
| C3 | This cut exports `ICronService` and `ICronJobRepository`. `runKernel()` does not start a timer. `overdueSlotDecision` is not in this tree. A one-shot wake-up is not performed here. | `src/domain/scheduling/cron-service.port.ts`. `src/kernel.ts` re-exports the port. MP-K9. |
| C4 | A tool body that requires approval does not run unless the call has `approvalGranted`. The agent loop sets that flag after a recorded approval. A batch records `ask` and skips the body. | `src/application/agents/services/ToolRegistry.ts`, `src/application/agents/AgentRunService.ts`, `src/infrastructure/agents/BatchToolExecutorAdapter.ts`. The laboratory tests are not shipped in this repository. |
| C5 | The outbox delivers at least once. A crash between the bus accept and the published mark leaves the row leased, then the worker tries again. | `docs/limitations.md` and `src/infrastructure/events/postgres-outbox.ts`. The kernel does not claim exactly-once across a network. |
| C6 | The kernel baseline is one forward file, `001_consolidated.sql`. A matching checksum skips it. A failed file does not store a checksum. | `src/infrastructure/database/migrations/001_consolidated.sql` and `src/infrastructure/database/migration-runner.ts`. The laboratory test is not shipped in this repository. |

## Words that are not claims

| Word | Means | Does not mean |
| --- | --- | --- |
| `pinned` | `package.json` names a 40-character commit of this kernel | The product has been accepted by a court or a customer |
| `ready` | `/health/ready` is 200 and the three real-store flags are on | A model answered correctly |
| TRL 4 | Self-assessed laboratory component, in the sense of ISO 16290 | A certificate, a pilot, or TRL 5 |

`USE_MOCK_AI=true` is a stub. It is not a row in this table.
