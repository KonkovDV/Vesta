# Claims

If a sentence in `README.md` disagrees with this file or with [limitations.md](limitations.md), this file and the limitations win.

These rows are claims about this source tree. They are not a deployment report and not a model score.

| ID | Claim | Where it is checked |
| --- | --- | --- |
| C1 | One process listens. `src/index.ts` calls `runKernel()`. Importing the package does not listen. | `docs/architecture.md` |
| C2 | A product pins a 40-character commit. A branch name is not a pin. | [adr/0001-kernel-as-package.md](adr/0001-kernel-as-package.md). Installing from a remote is MP-K5 and has not been run. |
| C3 | This cut exports `ICronService` and `ICronJobRepository`. `runKernel()` does not start a timer. `overdueSlotDecision` is not in this tree. A one-shot wake-up is not performed here. | `src/domain/scheduling/cron-service.port.ts`. `src/kernel.ts` re-exports the port. MP-K9. |
| C4 | A tool body that requires approval does not run unless the call has `approvalGranted`. The agent loop sets that flag after a recorded approval. A batch records `ask` and skips the body. The policy sees the validated arguments the body receives. | `src/application/agents/services/ToolRegistry.ts`, `src/application/agents/AgentRunService.ts`, `src/infrastructure/agents/BatchToolExecutorAdapter.ts`. `tests/unit/tool-registry.test.ts`. |
| C8 | One tool call runs its body once. `ToolCallStarted` is appended with the version the executor read. A second executor that loses that claim throws `AgentRunConflictError`. A resume that finds `AgentRunFinished` returns that result and does not run the body. A call started before a crash is journaled as `outcome_unknown`, not run again. | `tests/unit/agent-run-service.test.ts`, `tests/integration/agent-run-postgres.test.ts`. |
| C9 | A kernel extension cannot replace or remove a registered token through the container it receives. Extension code runs in the same process with full privileges: it can still mutate an object it resolves. This is a guard against mistakes, not a sandbox. | `src/kernel.ts` (`createExtensionContainer`), `tests/unit/kernel-extensions.test.ts`. |
| C10 | A tool with external effects (exec, writes, messages, browser, sessions, automation) waits for a person by default; the decision is recorded with its author and the arguments hash, and the run resumes. An extension can add constraints, not remove them. | `tests/unit/tool-policy-service.test.ts`, `tests/unit/agent-run-routes.test.ts`. |
| C11 | `getCommittedEventsAfter` returns every committed event once, in commit order, including one whose transaction drew a lower gsn and committed later. | `tests/integration/event-commit-order.test.ts`. |
| C5 | The outbox hands each row to the bus at least once. A crash between the bus accept and the published mark leaves the row leased, then the worker tries again. A failed row waits for its backoff; versions of one aggregate leave in order. The bus is Redis Pub/Sub: a message with no subscriber is accepted and lost (MP-K22). | `src/infrastructure/events/postgres-outbox.ts`, `tests/integration/outbox-delivery.test.ts`. The kernel does not claim exactly-once across a network. |
| C6 | The kernel ships `001_consolidated.sql`, `002_outbox_delivery.sql`, and `003_event_commit_order.sql`. A matching checksum skips a file. A failed file does not store a checksum and stops the run. | `src/infrastructure/database/migration-runner.ts`, `tests/unit/migration-runner.test.ts`; CI applies the files twice on pgvector/PostgreSQL 17. |
| C7 | Selected outbound calls connect to the addresses `pinUrl` just returned. A later DNS answer is not used for that socket. A redirect is pinned again. | `src/infrastructure/http/SsrfPinnedHttpClient.ts`. Call sites in this tree: ingestion in `memory.module.ts`, `A2AX402PaymentAdapters.ts`, `ContainerRegistryAdapter.ts`, `A2ATaskRunnerAdapter.ts`, `A2AStreamTransportAdapter.ts`, and outbound MCP over HTTP (`McpToolConsumerAdapter`, `tests/unit/mcp-consumer-pin.test.ts`). The `web-browser` plugin checks but Chrome resolves names itself. A validator without `pinUrl` is not this claim. |

## Words that are not claims

| Word | Means | Does not mean |
| --- | --- | --- |
| `pinned` | `package.json` names a 40-character commit of this kernel | The product has been accepted by a court or a customer |
| `ready` | `/health/ready` is 200 and the three real-store flags are on | A model answered correctly |
| TRL 4 | Self-assessed laboratory component, in the sense of ISO 16290 | A certificate, a pilot, or TRL 5 |

`USE_MOCK_AI=true` is a stub. It is not a row in this table.
