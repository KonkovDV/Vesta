# Release policy

## Versioning

Tags are `vMAJOR.MINOR.PATCH`.

- A break in `runKernel`, `KernelExtension`, the migration order, or `package.json` `exports` is a major bump.
- A new extension field or a new migration file is a minor bump.
- A fix that keeps those contracts is a patch.

## Before a tag

1. `npm ci` completes.
2. `npm run typecheck` completes with no errors.
3. `npm run build` completes, including SQL copy and alias rewrite.
4. README, `docs/limitations.md`, and `KNOWN_ISSUES.md` match the code that is tagged.
5. No secret and no customer database is in the tree. `.env.example` has placeholders only.
6. `package-lock.json` is the lockfile of this tag.

## What consumers pin

A product depends on the tag's commit SHA, 40 hex characters, not on `main`. Record that SHA in the product and fail its CI if `package.json` and that record diverge.

## Notes

Release notes name the commit range, the commands that were run, and any migration file that was added or changed. A green `microphoenix-migrate` line is not evidence that every statement ran: the runner's tests for `010` and `011` are the check for those two files.
