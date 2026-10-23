# Contributing

The kernel accepts a project as an extension (`runKernel`), not as a fork of this tree.

## Local check

Node.js 24.

```bash
npm ci
npm run typecheck
npm run build
```

`npm test` is not part of this package. The monorepo that produces this cut keeps the test suite.

## Pull requests

- Keep `src/index.ts` as the only process entry. Library code throws; it does not call `process.exit` on startup failure.
- A new public import belongs on `src/kernel.ts` and in `package.json` `exports` only as the package root. Do not add a second entry such as `microphoenix/dist/...`.
- Do not commit `.env` or a real secret. `.env.example` lists names and placeholders.
