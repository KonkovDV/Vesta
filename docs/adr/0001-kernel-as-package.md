# ADR-0001: The kernel is a pinned package

- **Status:** Accepted
- **Date:** 2026-10-23

## Decision

MicroPhoenix is published as a library. A product is another repository. It depends on one commit:

```json
{
  "dependencies": {
    "microphoenix": "github:KonkovDV/Vesta#<40-character sha>"
  }
}
```

The product calls `runKernel({ extensions })`. It does not fork this tree and it does not vendor a copy.

## Rules

- The pin is a full SHA. A branch name is not a pin.
- The product records that SHA in one place and its CI fails if `package.json` disagrees.
- Product SQL, product DI tokens, and product routes stay in the product.
- This repository does not gain a folder per product.
- The only supported import is the package root.

## Why

The same shape is already used for SynAPS and the products that sit on it (GridPlan, ProgramPlan, RepairFlow, SignPlan): the kernel stays one repository, and each product moves its pin on purpose.
