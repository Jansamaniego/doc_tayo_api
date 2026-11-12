# ADR-0006: oxlint stays; some rules are tests

Status: accepted (Phase 1)

oxlint (already the project linter) enforces no `process` global outside `src/config` and tests (`no-restricted-globals`), no `console`, and `eqeqeq`. oxlint 1.93 has no `no-restricted-syntax`, so a ban on the unsafe raw-SQL APIs lives in `test/architecture/forbidden-patterns.spec.ts`, which also double-checks the other rules. ESLint is not added.
