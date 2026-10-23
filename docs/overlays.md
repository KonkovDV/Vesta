# Project overlay

A product is a separate repository. It depends on one commit of this package and calls `runKernel`. It does not copy this tree and it does not put its rules inside the kernel's agent loop.

The kernel agent loop is a short run, eight steps by default. A case that lives for weeks or months is the project's own aggregate. The project appends its events, and the kernel stores them.

## What the kernel already provides

| Need | Contract |
| --- | --- |
| Facts that must survive a restart | `IEventStore`. Restore from a snapshot, then only the later events. |
| An external send whose business effect happens once | `IOutbox`. The row is stored first. Delivery is at least once, so the project's handler is idempotent. |
| A person must agree before an action | `IToolExecutionPolicy`. `requiresApproval` stops the tool body in `ToolRegistry` unless the call carries `approvalGranted`. A batch records `ask` and does not run that call. |
| A wake-up at a later time | `ICronService` and `ICronJobRepository`. A one-shot (`at`) that is overdue still runs once. A repeating job overdue by more than the catch-up window moves to its next slot. |
| The project's own tables | `microphoenix-migrate --dir`. Those files run after the kernel baseline. |
| The project's own HTTP routes | `KernelExtension.routes`, after the kernel routes. |
| An outbound HTTP call | Use the kernel's SSRF guard. A new client does not inherit it. |

Import these types from `microphoenix`. Deep paths under `microphoenix/dist` are closed.

## What stays in the project

- The states of the case and the table that chooses the next state.
- Money, dates, and any calendar of working days. Code computes them. A model does not.
- Connectors to the customer's system of record, mail, banks, and courts.
- Document templates and the person who signs a document with a legal effect.
- Text from an outside party. Treat it as data. It does not choose the next action, the recipient, or an amount.

## Order of an external action

1. The project proposes one action against the current case.
2. `IToolExecutionPolicy.evaluate` returns allowed, blocked, or approval required.
3. If approval is required, a person decides. The decision is an event.
4. The effect is written through the outbox. The recipient and the amount come from the case, not from the outside text.
5. A later wake-up is a cron job stored with the case id. The process may restart before it fires.

The reasoning, the citations, and the failure model are in [adr/0002-long-running-case.md](adr/0002-long-running-case.md).

The kernel does not file a claim, read a customer's accounting system, or move money. Those are a new project and, where they leave the machine, a new security boundary that needs an explicit decision before the code is written.
