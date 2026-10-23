# ADR-0003: What stays in the kernel

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** ADR-0001 (package), ADR-0002 (long-running case)

## Context

SynAPS records the same split in its ADR-0003. A domain with its own buyer lives in another repository and pins a kernel commit. A domain that is only an encoding of the kernel stays inside. MicroPhoenix needs the same rule, or every future product becomes a folder of this tree.

## Decision

Keep a rule in this repository only when all of the following hold:

1. It is about the process, the journal, the outbox, the schedule, the tool-call gate, or the way a project attaches.
2. It does not name a buyer, a statute, or a filing.
3. A second product can use the same rule without inheriting the first product's nouns.

Put a rule in a product repository when any of the following hold:

1. The product has its own buyer or its own name.
2. The rule is a statute, a tariff, a template, or a connector to someone else's system.
3. The product needs a checker that this kernel does not own.

A collections case, a court filing, and a statutory interest calculation fail the first list. They are a separate repository. This kernel does not gain a folder for them.

## Consequences

- The public types a product may import are the ones re-exported from `src/kernel.ts`.
- Product SQL runs after `001_consolidated.sql`, from a directory the product passes.
- Moving a product in later, as a subdirectory, is a new decision. This ADR does not allow it by default.
