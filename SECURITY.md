# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 4.3.x | best effort |
| 3.0.0 to 4.2.0 | no: upgrade to 4.3.x (the default Streams bus ignores `REDIS_TLS`, MP-K49; 3.0.x also turns product domains on by default, MP-K38) |
| 2.10.0 to 2.18.3 | no: upgrade to 4.3.x (the default bus loses events, MP-K22) |
| 2.9.0 | no: upgrade (MP-K11, MP-K13, MP-K17) |

## Reporting a vulnerability

Use GitHub Security Advisories on this repository. Do not open a public issue for an unfixed security bug.

Do not attach live credentials, `.env` files, customer databases, or production dumps.

## What this tree expects

- `JWT_SECRET` is at least 32 characters and is not the placeholder from `.env.example`.
- Database and Redis passwords in `docker-compose.yml` are for a local machine. Replace them before the ports are reachable beyond localhost.
- Outbound HTTP is pinned only where this tree calls `pinUrl` and then connects to those addresses: document ingestion, x402 settlement, container-registry GET, A2A, and outbound MCP over SSE or streamable HTTP when the guard is passed in. MCP stdio does not pin. A project HTTP client does not inherit the guard. `validateUrl` or `isSafe` alone does not pin the socket.
