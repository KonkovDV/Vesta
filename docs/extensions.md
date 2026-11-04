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

## Retries

Aspects apply by class name, to project classes too. `RetryAspect` wraps `*Adapter`, `*Repository`, and `*HttpClient` classes. It repeats a method only after a transient error, and only when the method is marked idempotent. A name such as `getRate` does not count. Mark one of two ways:

```ts
class RatesAdapter {
  static readonly idempotentMethods = ['getRate'];
  async getRate(currency: string): Promise<number> { /* GET */ }
  async settle(): Promise<void> { /* never repeated */ }
}

container.register('Rates', () => new RatesAdapter(), {
  aspectOptions: { methodMetadata: { getRate: { metadata: { idempotent: true } } } },
});
```

`aspectOptions: { metadata: { idempotent: true } }` marks every method of a service that only reads.

## MCP HTTP

`runKernel()` does not mount `/api/mcp`. The previous mount ran after the 404 handler, so every request answered 404. A product that wants Streamable HTTP calls `mountMcpHttp` from `routes`, which runs before that handler. The tool-policy agent id is `mcp-http-client`. The `:clientName` segment of the URL does not select a tool profile. This mount checks the kernel API key. It does not implement the MCP OAuth grant.

## Imports

Import `runKernel`, `KernelExtension`, `KernelStartError`, and the types re-exported from the package root. Deep paths under `microphoenix/dist` are closed by `package.json` `exports`.
