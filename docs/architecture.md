# Architecture

One Node.js process. The process entry is `src/index.ts`. It calls `runKernel()` and exits with code 1 when that call throws. Importing the package does not listen on a port.

## Chain

`src/index.ts` → `src/kernel.ts` → `src/core/bootstrap/orchestrator.ts` → `src/infrastructure/di/bootstrap.ts` → `src/application/app.ts`.

No other file calls `express.listen()`.

## Layers

| Layer | Owns |
| --- | --- |
| `domain` | Contracts and rules. No database driver, no HTTP server. |
| `application` | Use cases and the HTTP application. |
| `infrastructure` | PostgreSQL, Redis, model clients, plugins, the migration runner. |
| `core` | DI container, configuration, bootstrap. |

A project does not add a new folder inside this repository. It depends on one commit and passes a `KernelExtension`. A case that lives for weeks is the project's aggregate. The kernel stores its events and delivers its external effects through the outbox. It does not start a cron timer. See [overlays.md](overlays.md) and [adr/0003-product-placement.md](adr/0003-product-placement.md).

## Mediation

A tool body runs through `ToolRegistry.execute`. That method asks `IToolExecutionPolicy` and, when the decision requires approval, runs the body only if the call carries `approvalGranted`. The agent loop sets the flag after a person approves that call. A batch that receives the same decision records `ask` and skips the body. This cut does not apply an overdue-schedule rule: that function is not in the tree. The literature and the non-claims are in [research/long-running-case.md](research/long-running-case.md).

## Outbound HTTP

The DNS guard returns the addresses it just checked. The socket for that call uses those addresses. A redirect is checked again. A redirect from HTTPS to HTTP is refused. This applies to document ingestion, x402 settlement, a container-registry GET, and A2A when the guard is passed in. Outbound MCP in this cut is `McpToolConsumerAdapter`: it does not call `pinUrl`. MP-K10. A client the project adds does not inherit the guard. A check that only returns `isSafe` or `validateUrl` does not choose the socket address.

## Order at start

1. Optional process handlers (`SIGTERM`, `SIGINT`, uncaught errors). On a failed start they are removed.
2. Telemetry, then integrity checks, then configuration.
3. Kernel DI registrations.
4. Each extension `register`, in array order. A duplicate name, an empty name, or a token the kernel already registered throws.
5. HTTP. Kernel routes, then extension routes, then the 404 handler.
6. SQL is not applied here. `microphoenix-migrate` applies kernel SQL, then each `--dir`.

## Package boundary

`package.json` `exports` exposes the package root. A path such as `microphoenix/dist/infrastructure/...` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. TypeScript path aliases in `dist/` are rewritten to relative paths at build time, so the installed package does not need `module-alias`.
