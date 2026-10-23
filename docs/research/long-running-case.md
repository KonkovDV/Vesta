# A case that outlives the process

This note maps published results onto files in this kernel. It does not add a product. A collections case, a filing, and a statutory sum stay in a future repository. See [../adr/0003-product-placement.md](../adr/0003-product-placement.md).

The operational invariants are [../adr/0002-long-running-case.md](../adr/0002-long-running-case.md). If this note and that ADR disagree, the ADR wins. If either disagrees with [../limitations.md](../limitations.md), the limitations win.

## What was taken from the neighbouring repositories

Read on this machine, not from memory of their READMEs:

| Repository | What it does that this kernel now does too | What it does that this kernel does not copy |
| --- | --- | --- |
| `C:\SynAPS` | README states the claim boundary before the install. `CITATION.cff` says what a citation is allowed to mean. ADR-0003 separates an in-kernel encoding from a product repository. | Solver names, benchmark wall times, Scorecard badge. Those are about a different algebra, and the badge needs a published repository. |
| `C:\SynAPS-GridPlan` | Header table: version, pin vocabulary, maturity, author. A claim points at a file. TRL 4 is labelled as a self-assessment. | The maintenance-planning model, the Rust checker, and the contest packet. |
| `C:\SynAPS-RepairFlow` | The README says that when it disagrees with the limitations, the limitations win. | The repair checker. This kernel does not grow a second checker for someone else's statute. |
| `C:\SynAPS-ProgramPlan` | Measured rows name the protocol that produced them. | The numbers in that README. They are not measurements of this repository. |

The pin rule those products use is already ADR-0001 here: a full commit SHA, never a branch tip.

## Literature, and the file it constrains

Each citation is used for one design choice. None of them was re-run as an experiment in this repository.

**Complete mediation.** Saltzer and Schroeder, *The Protection of Information in Computer Systems*, Proceedings of the IEEE 63(9), 1975, require every access to be checked, not only the access that goes through a careful caller. Anderson's *Computer Security Technology Planning Study* (ESD-TR-73-51, the 1972 study issued as that report) states the same requirement as a reference monitor that is always invoked. In this tree the monitor for a tool body is `ToolRegistry.execute`. It refuses `requiresApproval` unless `approvalGranted` is true. `AgentRunService` sets that flag only on the resume that follows a recorded approval (`executeCall` is called with `alreadyApproved` true at that site). `BatchToolExecutorAdapter` maps the same flag to decision `ask` and does not call `execute`. A check that runs after the body is not this monitor: `ToolRegistry` still logs a result of `{ status: 'approval_required' }`, and that log happens only because the body already returned.

**A bounded episode.** Yao, Zhao, Yu, Du, Shafran, Narasimhan, and Cao, *ReAct: Synergizing Reasoning and Acting in Language Models*, ICLR 2023, interleave a thought with an action and an observation inside one episode. `AgentRunService` stops at `maxSteps` (the default in that file is 8). A case that must be readable after restart is an aggregate in `IEventStore`, written by the product. It is not the step counter.

**Local transactions, uncertain remote outcome.** Garcia-Molina and Salem, *Sagas*, ACM SIGMOD Record 16(3), 1987, split a long business process into local transactions. Helland, *Life beyond Distributed Transactions: an Apostate's Opinion*, CIDR 2007, treats a step that crosses entities as an activity whose outcome is uncertain. The local fact in this kernel is the event row plus the outbox row, committed together. Another organisation's system is not enlisted in that transaction.

**At least once, and an idempotent effect.** Helland, *Idempotence Is Not a Medical Condition*, Communications of the ACM 55(5), 2012, separates a delivery that can be repeated from an effect that is safe to repeat. Kleppmann, *Designing Data-Intensive Applications*, O'Reilly, 2017, makes the same cut: exactly-once processing is a property of the consumer's effect, not a promise that the network handed the message over once. The outbox mark is one `UPDATE` after the bus accepts the batch. A crash before that mark leaves the row `PROCESSING` until the lease ends, and the worker delivers it again. The product supplies the idempotent effect. This kernel does not.

**A total order on one journal is not an order across organisations.** Lamport, *Time, Clocks, and the Ordering of Events in a Distributed System*, Communications of the ACM 21(7), 1978, defines a partial order from happens-before. The global sequence number assigned in one PostgreSQL transaction is a total order of events that committed to this store. It does not order a remote side effect, and it is not a Lamport clock between this process and a court or a bank.

**Untrusted data.** Greshake, Abdelnabi, Mishra, Endres, Holz, and Fritz, *Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection*, AISec 2023, showed instructions hidden in retrieved data being followed as if the user had typed them. The policy sees the tool name and the arguments. It does not read a letter. The product must not copy raw outside text into the arguments that select a recipient or an amount. CaMeL (Debenedetti and others, 2025) is a stronger construction. It is not implemented here and it is not claimed.

**A statutory function.** Merigoux, Chataing, and Protzenko, *Catala: A Programming Language for the Law*, ICFP 2021, attach a computation to the text of the rule. This kernel has no statute and no such function.

**A sample with no events.** Brown, Cai, and DasGupta, *Interval Estimation for a Binomial Proportion*, Statistical Science 16(2), 2001, show that a sample of successes with zero failures still has an upper bound on the failure probability. This kernel does not compute that bound. A product that reports a clean sample publishes the bound with the count.

**One-shot time versus a repeating slot.** A repeating schedule can drop a missed slot and keep the next one. A one-shot cannot. `overdueSlotDecision` returns `run` for `kind: 'at'` even when the instant is older than the catch-up window and even when catch-up is disabled. Repeating kinds return `advance` past the window and `skip` when catch-up is off. The timer manager does not re-decide this. The kernel does not know which instants are statutory. The product computes the instant.

## What this note does not establish

No figure from an investment memorandum is a measurement of this repository. No model was scored here. No message was sent to a court, a bank, or a customer's accounting system. The neighbouring repositories were read as examples of how a kernel states its boundary. Their domain results were not imported.
