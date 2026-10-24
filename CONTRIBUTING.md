# Contributing

The kernel accepts a project as an extension (`runKernel`), not as a fork of this tree.

## Local check

Node.js 24.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Integration tests need a database: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm run test:integration` (pgvector required). Each claim in `docs/claims.md` names its test; a change to a claim changes its test in the same pull request.

## Pull requests

- Keep `src/index.ts` as the only process entry. Library code throws; it does not call `process.exit` on startup failure.
- A new public import belongs on `src/kernel.ts` and in `package.json` `exports` only as the package root. Do not add a second entry such as `microphoenix/dist/...`.
- Do not commit `.env` or a real secret. `.env.example` lists names and placeholders.
