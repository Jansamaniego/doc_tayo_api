# ADR-0002: TypeScript strictness

Status: accepted (Phase 1)

`strict: true` stays. `noImplicitOverride` and `noUncheckedIndexedAccess` are deliberately not enabled yet: there is little domain code to benefit and they add churn. Revisit at the start of Phase 2.
