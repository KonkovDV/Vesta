# Vesta

Event-sourced server kernel. The package name is `microphoenix`. A product pins one commit of [github.com/KonkovDV/Vesta](https://github.com/KonkovDV/Vesta).

Language: **EN** | [RU](README_RU.md)

| | |
| --- | --- |
| GitHub default branch | `main` |
| Repository | [KonkovDV/Vesta](https://github.com/KonkovDV/Vesta) |

[![CI](https://github.com/KonkovDV/Vesta/actions/workflows/ci.yml/badge.svg)](https://github.com/KonkovDV/Vesta/actions/workflows/ci.yml)
[![Node.js 24](https://img.shields.io/badge/node.js-24-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![cite](https://img.shields.io/badge/cite-CITATION.cff-orange.svg)](CITATION.cff)

PostgreSQL keeps the journal. The outbox carries the effect out. Redis is the bus. Express serves HTTP. The agent loop does not run a tool until a person grants that call. A project adds services, routes, and SQL without editing this tree.

If this page disagrees with [docs/limitations.md](docs/limitations.md) or [docs/claims.md](docs/claims.md), those files win.

| Field | Value |
| --- | --- |
| Version | 2.9.0 (`package.json`) |
| Runtime | Node.js 24 |
| Maturity | Self-assessed TRL 4 in the sense of ISO 16290: a component exercised in the laboratory. Not a certificate and not a deployed service. |
| Status words | `pinned` — a product names a 40-character commit. `ready` — `/health/ready` is 200 with the three real-store flags. Neither word means a model is accurate or a filing was sent. |
| Author | Konkov D. V. (`@KonkovDV`) |
| Shape | One kernel repository, products in their own repositories, as in [SynAPS](https://github.com/KonkovDV/SynAPS). The placement rule is [docs/adr/0003-product-placement.md](docs/adr/0003-product-placement.md). |

## What is claimed

The process entry, the pin, the outbox, and the approval gate are listed in [docs/claims.md](docs/claims.md). This repository does not start a cron timer. The workflow badge runs `npm run typecheck` only. Cite [CITATION.cff](CITATION.cff) together with the commit you pinned.

## What is not claimed

A web client, a collections product, a measured model score, exactly-once delivery to another organisation, or a statutory calculator. `USE_MOCK_AI=true` starts a stub model client. The literature map is [docs/research/long-running-case.md](docs/research/long-running-case.md).

## What it does

- Starts one process: `src/index.ts` calls `runKernel()`.
- Restores state from an append-only event journal.
- Publishes through an outbox. Delivery to another system is at least once.
- Lets a project add services, HTTP routes, and SQL migrations without editing the kernel.
- Refuses to replace a service the kernel already registered.
- Stops a tool body in `ToolRegistry` when the call requires approval and does not carry `approvalGranted`.
- Connects selected outbound HTTP calls to the addresses the SSRF guard just checked. A client a project adds does not inherit that guard.

## What it does not do

See [docs/limitations.md](docs/limitations.md). This package is not a web client, not a collections product, and not a claim that a model is accurate. `USE_MOCK_AI=true` starts a stub model client.

## Install the server

```bash
cp .env.example .env
# JWT_SECRET must be at least 32 characters: openssl rand -hex 32
docker compose up -d postgres redis
docker compose --profile migrate run --rm migrate
docker compose up --build app
```

```bash
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
```

`/health/ready` is 200 when the event store, the bus, and the outbox answer. Postgres and Redis are not published on the host. If port 3000 is taken, set `APP_PORT`.

Without Docker, with Node 24:

```bash
npm ci
npm run build
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB npm run migrate
npm start
```

Readiness checks the real stores only when `FF_USEREALEVENTSTORE`, `FF_USEREALEVENTBUS`, and `FF_USEREALOUTBOX` are true. `docker-compose.yml` sets them.

## Depend on a commit

```json
{
  "dependencies": {
    "microphoenix": "github:KonkovDV/Vesta#<40-character commit sha>"
  }
}
```

`npm install` builds `dist/` through the `prepare` script. Move the pin on purpose and rerun the product's own tests. Do not track a branch tip.

```ts
import path from 'node:path';
import { runKernel, type KernelExtension } from 'microphoenix';

const cases: KernelExtension = {
  name: 'cases',
  register(container) {
    container.register('CaseRepository', () => ({ ready: true }), { lifecycle: 'singleton' });
  },
  routes(app, { authMw, rateLimitMw }) {
    app.get('/api/v1/cases', authMw, rateLimitMw, (_req, res) => {
      res.json({ items: [] });
    });
  },
  migrationsDir: path.resolve(__dirname, '../migrations'),
};

void runKernel({ extensions: [cases] });
```

`register` runs after the kernel's DI bootstrap. A second registration of a kernel token throws. `routes` run after the kernel routes and before the 404 handler. Project SQL runs after kernel SQL:

```bash
npx microphoenix-migrate --dir ./migrations
```

The only supported import is `microphoenix`. `microphoenix/dist/...` is rejected with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

`runKernel()` throws `KernelStartError` and leaves the process running. `src/index.ts` is the process entry: it exits with code 1. Shutdown handlers (`SIGTERM`, `SIGINT`, uncaught errors) still exit the process. Pass `processHandlers: false` when another supervisor owns the process.

## Commands

| Command | Effect |
| --- | --- |
| `npm run typecheck` | Typecheck, no emit |
| `npm run build` | `dist/` plus `.d.ts`, copy SQL, rewrite `@/` aliases to relative paths |
| `npm run migrate` | Apply kernel migrations. Extra directories: `npm run migrate -- --dir ./migrations` |
| `npm start` | `node dist/index.js` |

The kernel baseline is one file, `001_consolidated.sql`. The second run skips it when the checksum matches. A project directory passed with `--dir` still runs after it.

## Outbound HTTP

When `ISsrfDnsGuard` is registered, these calls open the socket on the pinned addresses. A later DNS answer is not used for that socket. A redirect is pinned again. A redirect from HTTPS to HTTP is refused.

| Call | How |
| --- | --- |
| Document ingestion | `selectIngestionHttpClient` |
| x402 settlement | `pinnedExchange` |
| Container registry GET | `pinnedExchange` when the guard has `pinUrl` |
| A2A discovery, JSON-RPC, and the event stream | the same pin, passed in from DI |
| Outbound MCP | Not pinned. `McpToolConsumerAdapter` opens the SDK transport on the URL. MP-K10. |

A validator that only answers `isSafe` or `validateUrl` still checks and then fetches. That is not a pin. The laboratory media store and the laboratory MCP client registry are not in this cut. See [docs/limitations.md](docs/limitations.md).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [RELEASE_POLICY.md](RELEASE_POLICY.md). History: [CHANGELOG.md](CHANGELOG.md). What this cut does not prove: [AUDIT.md](AUDIT.md) and [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Documentation

| Path | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Process, layers, extension order |
| [docs/extensions.md](docs/extensions.md) | How a project pins a commit and adds itself |
| [docs/overlays.md](docs/overlays.md) | What a long-running product keeps, and what it asks of the kernel |
| [docs/limitations.md](docs/limitations.md) | Non-claims. Wins over this page. |
| [docs/claims.md](docs/claims.md) | Claims and the test or file behind each one |
| [docs/research/long-running-case.md](docs/research/long-running-case.md) | Literature, and the file each citation constrains |
| [docs/adr/0001-kernel-as-package.md](docs/adr/0001-kernel-as-package.md) | Why the kernel is a package, not a fork |
| [docs/adr/0002-long-running-case.md](docs/adr/0002-long-running-case.md) | A months-long case is not an agent episode |
| [docs/adr/0003-product-placement.md](docs/adr/0003-product-placement.md) | Which rules stay in the kernel |

## License

[MIT](LICENSE)
