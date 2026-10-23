# Extensions

A project is a separate package. It depends on one commit of `microphoenix` and calls `runKernel`.

```json
{
  "dependencies": {
    "microphoenix": "github:KonkovDV/Vesta#<40-character commit sha>"
  }
}
```

Record that SHA in one source file of the project and test that `package.json` contains the same SHA. Do not pin a branch.

## Order

1. The kernel registers its own services.
2. Each extension `register` runs, in array order. A duplicate extension name throws. A token that is already registered throws.
3. The HTTP app is built. Kernel routes mount, then each extension `routes`, then the 404 handler.
4. `microphoenix-migrate` applies kernel SQL, then each `--dir`, in the order given.

`migrationsDir` on an extension is the path you pass to `--dir`. `runKernel` does not apply SQL itself.

## Imports

Import `runKernel`, `KernelExtension`, `KernelStartError`, and the types re-exported from the package root. Deep paths under `microphoenix/dist` are closed by `package.json` `exports`.
