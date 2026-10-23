# MicroPhoenix kernel

This repository is the server kernel. A product is a separate repository that depends on one 40-character commit of this package and calls `runKernel`. Do not copy this tree into a product, and do not put product rules (collections, 1C, a web client) into this repository.

Default branch: `main`.

Public import surface: the package root (`microphoenix`). `package.json` `exports` has `.` and `./package.json` only.

`src/index.ts` is the process entry. It may exit. `runKernel` throws `KernelStartError` and does not call `process.exit`.

Do not claim model quality, a live integration, or a green migration from a log line alone. Cite the command and the file that was checked. Open limits are in `KNOWN_ISSUES.md`.
