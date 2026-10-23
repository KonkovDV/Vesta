# ADR-0002: A long-running case is not an agent episode

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

Some products built on this kernel follow one case for weeks or months: a deadline, a human signature, an effect in another organisation's system, then a later wake-up. The documents that prompted this note describe a collections case. The kernel does not implement that product. It fixes the process boundary those products need.

## Decision

A case is the project's aggregate. The kernel stores its events, delivers its external effects, asks a person when the project requires it, and wakes a persisted one-shot job. The kernel's agent loop is a different object.

## Invariants

1. **A short episode is not a case.** `AgentRunService` stops after eight steps unless the caller sets another limit. That is a bounded tool loop. Yao, Zhao, Yu, and others describe this shape as interleaving a thought with an action and an observation (`ReAct`, ICLR 2023). A case that must survive restart is appended to `IEventStore` under the project's own id. Putting the case inside the eight-step loop drops the steps that do not fit and loses the case log.

2. **The remote effect is not one transaction with the local fact.** Garcia-Molina and Salem (`Sagas`, SIGMOD 1987) split a long business process into local transactions with compensations. Helland (`Life beyond Distributed Transactions`, CIDR 2007) treats work that crosses entities as an activity whose outcome is uncertain. This kernel commits the intent in PostgreSQL and publishes it later through `IOutbox`. A customer's accounting system, a mail gateway, and a court are other entities. They are not enlisted in the kernel's transaction.

3. **Delivery is at least once. The business effect must be idempotent.** The outbox may hand the same row to the publisher more than once. A crash after the remote call and before the published mark leaves the row in `PROCESSING` until its lease ends, and the worker tries again. The project makes the remote effect idempotent. The kernel does not provide exactly-once delivery across a network.

4. **Outside text does not choose the action.** Greshake, Abdelnabi, Mishra, Endres, Holz, and Fritz showed that instructions hidden in data retrieved by a model are executed as if the user had typed them (`Not what you've signed up for`, AISec 2023). `IToolExecutionPolicy.evaluate` runs before the tool body and sees the tool name and its arguments. It does not read a letter. The project must not copy raw outside text into the arguments that select a recipient or an amount. The plan that motivated this note cites CaMeL (Debenedetti and others, 2025) for a stronger proof. This kernel does not reproduce that proof.

5. **A statutory amount is a tested function.** Merigoux, Chataing, and Protzenko (`Catala`, ICFP 2021) attach each computation to the text it implements. This kernel has no statute. The project owns the pure functions, the citation of the rule, and the tests. A model may draft prose. It does not compute the sum.

6. **Zero observed failures are not a proof.** Brown, Cai, and DasGupta (`Interval Estimation for a Binomial Proportion`, Statistical Science, 2001) show that a sample with no events still has an upper bound. This kernel does not compute that bound. A project that reports "no wrongful send in n tries" publishes the bound with the count.

7. **A one-shot wake-up is not a repeating slot.** `CronSchedule` of kind `at` is one instant stored in PostgreSQL. Repeating jobs that are overdue by more than the catch-up window (one hour unless configured) move to the next slot. A one-shot has no next slot, so an overdue one-shot still runs once when the process returns. The kernel does not know which instants are statutory. The project computes the instant, including any move to the next working day.

8. **Approval is checked at the call that runs the tool.** Saltzer and Schroeder (*The Protection of Information in Computer Systems*, Proceedings of the IEEE, 1975) require every access to pass the check, not only a well-behaved caller. `ToolRegistry.execute` throws when `requiresApproval` is set and the call does not carry `approvalGranted`. `AgentRunService` sets that flag only after a person has approved the same call. A batch records `ask` and does not run the body. The person's decision is the project's event. A signature on a filing is that event, not the boolean. `ToolProtectionAspect` is not on this path.

## Non-claims

This note does not verify market figures, statutes, or names in any product memorandum. It does not file a claim, read a customer's books, or move money. Those steps are a separate repository and, where they leave this process, a new security boundary.
