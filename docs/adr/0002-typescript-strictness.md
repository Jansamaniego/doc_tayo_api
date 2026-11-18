# ADR-0002: TypeScript strictness

Status: accepted (Phase 1); amended in Phase 2

`strict: true` stays. `noImplicitOverride` and `noUncheckedIndexedAccess` are deliberately not enabled yet: there is little domain code to benefit and they add churn. Revisit at the start of Phase 2.

## Amendment (Phase 2)

`noImplicitOverride` and `noUncheckedIndexedAccess` are now enabled (plans/01-multitenancy.md, D6). The guard chain and the tenant-scoped Prisma extension index arrays and records where a silent `undefined` would weaken isolation, so unchecked reads are compile errors.
