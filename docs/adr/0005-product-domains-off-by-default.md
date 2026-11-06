# ADR-0005: Product domains are off by default

- **Status:** Accepted
- **Date:** 2026-11-05
- **Related:** ADR-0001 (package), ADR-0003 (what stays in the kernel), MP-K32, MP-K38

## Context

ADR-0003 keeps a rule in this repository only when it is about the process, the journal, the outbox, the schedule, the tool-call gate, or the way a project attaches. This tree still holds five product domains: sales, HR, healthcare (MRI second opinion and its ingestion and delivery workers), research reports, and x402 paid A2A execution (MP-K38). Until 4.0.0 `runKernel()` registered their services, started the healthcare workers, and mounted `/api/v1/sales`, `/api/v1/hr`, and `/api/v1/healthcare` in every deployment, whether it used them or not. Those routes answered without a scope check until 2.11.0 (MP-K32).

Moving five domains into product repositories at once would be a rewrite. The usual way out of a monolith is incremental: identify the core, extract one capability at a time while the system keeps running, keep each step small and reversible, and let modules meet through interfaces so that extraction swaps an implementation without touching callers. The kernel already has that interface: a product is a `KernelExtension` that registers services, adds routes, and passes SQL to `microphoenix-migrate --dir`.

## Decision

Step 1, in 4.0.0:

1. Each product domain is off unless the deployment sets its flag to `true` (or `1`): `MODULE_SALES_ENABLED`, `MODULE_HR_ENABLED`, `MODULE_HEALTHCARE_ENABLED`, `MODULE_RESEARCH_ENABLED`, `MODULE_X402_ENABLED`. The research and healthcare names existed and defaulted to on; now every flag defaults to off.
2. Off means: no use cases, no controllers, no infrastructure services, no workers, no routes for that domain. `src/config/product-domains.ts` is the only place that reads the flags.
3. With every flag on, the kernel registers and mounts what 3.0.1 did. CI runs the resolve-all and route gates both ways.

Step 2, next: each domain becomes a `KernelExtension` in its product repository, pinned to a kernel commit, and its code and flag leave this tree. Step 3: dependencies that only those products use become optional.

## Measured

Kernel booted with the CI gate environment on PostgreSQL 16 and Redis 7, three boots each:

| | 3.0.1 | 4.0.0, flags unset | 4.0.0, all flags on |
| --- | --- | --- | --- |
| Registered DI tokens | 367 | 327 | 367 |
| Tokens that do not resolve (`USE_MOCK_AI=true`) | 27 | 24 | 27 |
| Mounted routes | 58 | 50 | 58 |
| Loaded modules (`require.cache`) | 3779 | 3776 | — |
| RSS after 5 s, MB | 353–396 | 372–394 | — |

Step 1 shrinks what a deployment exposes and runs. It does not shrink memory or the import graph: the product modules are still imported. The memory target of T2.1 needs step 2.

The table is the 4.0.0 measurement. The 4.3.0 resolve-all gate with the flags unset registered 326 tokens, not 327: `IDeepResearchService` is registered only when the research domain is on (MP-K57). Routes stayed 50.

## Consequences

- A deployment that served sales, HR, or healthcare routes, or used research or x402 services, sets the matching flag when it moves to 4.0.0. That is why this is a major version.
- `tests/gates/resolve-all-budget.json` keeps its 27 names, because the all-on run still needs them.
- Code that resolves a product token in a deployment with that domain off fails at resolve time with the token name, rather than running a service nobody configured.

## Sources

- Strangler migration, small reversible steps while the system keeps running: https://dev.to/oluwatosinolamilekan/from-monolith-to-modular-a-strangler-migration-playbook-527p
- Modular monolith to services, modules meet through interfaces, extraction order: https://dev.to/sepehr/from-monolith-to-modular-monolith-to-microservices-realistic-migration-patterns-36f2
- Identify the core before strangling: https://view.ceros.com/persistent-systems/private-equity-whitepaper-1-1-2-2-1-7-1-1-1-1
