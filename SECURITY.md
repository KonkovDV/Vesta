# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 2.9.0 | best effort |

## Reporting a vulnerability

Use GitHub Security Advisories on this repository. Do not open a public issue for an unfixed security bug.

Do not attach live credentials, `.env` files, customer databases, or production dumps.

## What this tree expects

- `JWT_SECRET` is at least 32 characters and is not the placeholder from `.env.example`.
- Database and Redis passwords in `docker-compose.yml` are for a local machine. Replace them before the ports are reachable beyond localhost.
- Outbound HTTP from the kernel must go through the SSRF guard. A project that adds its own HTTP client does not inherit that guard unless it calls it.
